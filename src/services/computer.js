'use strict';
/**
 * Windows Computer runtime — P3 Production Hardening rewrite.
 *
 * v2.9.9 truth (audit): title-substring identity, unverified SetForegroundWindow,
 * blind raw-coordinate clicks, flat UIA dump, no DPI/multi-monitor awareness,
 * child.kill() passed off as tree cleanup, clipboard overwritten without
 * restore, password values read verbatim. Every one of those is now fenced:
 *
 *   identity      WindowRef (HWND+PID) discovered once, re-validated per action
 *   foreground    every mutation verifies GetForegroundWindow == target HWND
 *   observations  interactive actions require a fresh observationId (TTL + live
 *                 geometry re-check); drift ⇒ STALE_OBSERVATION, exec = 0
 *   coordinates   normalized 0..1 bound to an observation; backend converts to
 *                 physical + enforces target bounds (DPI-aware helper process)
 *   UIA           true TreeWalker traversal, bounded, elementRef by path+RuntimeId,
 *                 IsPassword values never returned
 *   input chain   UIA ValuePattern > target-bound clipboard paste (restored in
 *                 finally) > target-bound SendKeys
 *   screenshots   virtual-screen aware, PrintWindow first + honest captureMethod,
 *                 minimized ⇒ MINIMIZED_WINDOW_UNCAPTURABLE, temp residue = 0
 *   lifecycle     taskkill /T /F (argument array) + bounded quiescence; the
 *                 active registry only shrinks on CONFIRMED exit
 *
 * The ComputerManager stays the single Computer runtime — sessions, lock and
 * observations are injected subsystems, not a new framework. Legacy callers
 * (DesktopAgentBridge, WorkBuddy adapter, Computer panel) keep working through
 * the same method names, now honest about failures.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const psHost = require('./computer/psHost');
const coords = require('./computer/coordinates');
const winId = require('./computer/windowIdentity');
const { DesktopInteractionLock } = require('./computer/desktopInteractionLock');
const { ObservationStore, makeElementRef } = require('./computer/computerObservation');

const { runPs, psLiteral, PS_PRELUDE } = psHost;

/** Compatibility wrapper: old call sites use ps(script, timeoutMs). */
function ps(script, timeoutMs = 30000) { return runPs(script, { timeoutMs }); }

const ACTION_HISTORY_LIMIT = 200;
const MAX_CAPTURE_PIXELS = 4096 * 4096;
const MAX_VISION_DIM = 1920;

/**
 * Escape text for SendKeys (wrap specials in braces; never strip characters).
 */
function escapeSendKeys(s) {
  return String(s == null ? '' : s).replace(/[+^%~(){}\[\]]/g, m => '{' + m + '}');
}

/* ------------------------------------------------------------------ scripts */

const NATIVE_CORE = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ADPC {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static bool ValidateTarget(IntPtr h, uint expectedPid, out uint actualPid) {
    actualPid = 0;
    if (h == IntPtr.Zero || expectedPid == 0 || !IsWindow(h)) return false;
    GetWindowThreadProcessId(h, out actualPid);
    return actualPid == expectedPid;
  }
  public static bool ActivateTarget(IntPtr h) {
    uint ignoredPid = 0;
    uint currentThread = GetCurrentThreadId();
    uint targetThread = GetWindowThreadProcessId(h, out ignoredPid);
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredPid);
    bool attachedForeground = false;
    bool attachedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      if (targetThread != 0 && targetThread != currentThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
      ShowWindow(h, 9);
      BringWindowToTop(h);
      return SetForegroundWindow(h);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
"@`;

/** P3 Closure (C7) — action-time identity guard. Emitted INSIDE the same
 * helper that performs the mutation, as close to the OS call as possible:
 * the JS pre-check and the Win32 mutation must not be separated by a window
 * where the HWND can be closed and recycled (TOCTOU). Missing PID fails
 * closed; compatibility callers never gain an identity exception.
 * Any missing/mismatched identity ⇒ executed = false. */
function pidGuardPs(hwndVar, expectedPid) {
  const pid = Math.trunc(Number(expectedPid)) || 0;
  if (!pid) return `
@{ok=$false; code="TARGET_IDENTITY_REQUIRED"; executed=$false; reason="expected-pid-missing"} | ConvertTo-Json -Compress; exit`;
  return `
$adpExpectedPid = [uint32]${pid}; $adpLivePid = [uint32]0;
if (-not [ADPC]::ValidateTarget(${hwndVar}, $adpExpectedPid, [ref]$adpLivePid)) { @{ok=$false; code="STALE_WINDOW"; executed=$false; actualPid=$adpLivePid; reason="pid-changed"} | ConvertTo-Json -Compress; exit }`;
}

function shotPidGuardPs(expectedPid) {
  const pid = Math.trunc(Number(expectedPid)) || 0;
  if (!pid) return `@{ok=$false; code="TARGET_IDENTITY_REQUIRED"; executed=$false; reason="expected-pid-missing"} | ConvertTo-Json -Compress; exit`;
  return `$adpExpectedPid = [uint32]${pid}; $adpLivePid = [uint32]0;
if (-not [ADPShot]::ValidateTarget($h, $adpExpectedPid, [ref]$adpLivePid)) { @{ok=$false; code="STALE_WINDOW"; executed=$false; actualPid=$adpLivePid; reason="pid-changed"} | ConvertTo-Json -Compress; exit }`;
}

/** focus: restore-if-minimized is an explicit caller decision; Alt-trick + bounded
 * poll + GetForegroundWindow verification. Never "process exists ⇒ ok".
 * The Alt trick is ONLY used when actually needed: pressing Alt in a window
 * that is already foreground switches WPF/WinForms into access-key mode and
 * silently moves the keyboard focus away from the user's control. */
const FOCUS_PS = (hwnd, expectedPid, verifyMs) => `${PS_PRELUDE}
${NATIVE_CORE}
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
if ([ADPC]::IsIconic($h)) { [ADPC]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 250 }
if ([ADPC]::GetForegroundWindow() -ne $h) {
  ${pidGuardPs('$h', expectedPid)}
  [ADPC]::keybd_event(18,0,0,[IntPtr]::Zero);
  [ADPC]::ActivateTarget($h) | Out-Null;
  [ADPC]::keybd_event(18,0,2,[IntPtr]::Zero);
}
$ok = ([ADPC]::GetForegroundWindow() -eq $h);
for ($i = 0; ($i -lt 16) -and (-not $ok); $i++) {
  Start-Sleep -Milliseconds ${Math.max(10, Math.ceil(verifyMs / 16))};
  $ok = ([ADPC]::GetForegroundWindow() -eq $h);
  if (-not $ok) {
    ${pidGuardPs('$h', expectedPid)}
    [ADPC]::keybd_event(18,0,0,[IntPtr]::Zero);
    [ADPC]::ActivateTarget($h) | Out-Null;
    [ADPC]::keybd_event(18,0,2,[IntPtr]::Zero);
  }
}
${pidGuardPs('$h', expectedPid)}
@{ok=$ok; code=if ($ok) { "" } else { "FOREGROUND_NOT_ACQUIRED" }; foreground=[ADPC]::GetForegroundWindow().ToInt64()} | ConvertTo-Json -Compress`;

/** Atomic foreground fence + click. exec=0 unless the target is foreground. */
const CLICK_PS = (hwnd, expectedPid, x, y, downFlag, upFlag) => `${PS_PRELUDE}
${NATIVE_CORE}
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
$fg = [ADPC]::GetForegroundWindow();
if ($fg -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false; foreground=$fg.ToInt64()} | ConvertTo-Json -Compress; exit }
$adpRect = New-Object ADPC+RECT;
if (-not [ADPC]::GetWindowRect($h, [ref]$adpRect)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
if (${Math.trunc(Number(x))} -lt $adpRect.Left -or ${Math.trunc(Number(x))} -ge $adpRect.Right -or ${Math.trunc(Number(y))} -lt $adpRect.Top -or ${Math.trunc(Number(y))} -ge $adpRect.Bottom) { @{ok=$false; code="COMPUTER_TARGET_BOUNDS_VIOLATION"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
if (-not [ADPC]::SetCursorPos(${Math.trunc(Number(x))}, ${Math.trunc(Number(y))})) { @{ok=$false; code="CURSOR_POSITION_FAILED"; executed=$false} | ConvertTo-Json -Compress; exit }
# Let the target process consume the cursor-move before the button pair. This
# bounded 25 ms stabilization prevents WPF from occasionally hit-testing the
# preceding cursor location. Identity and foreground are checked again at the
# actual button-down action point, so the wait cannot create a retarget gap.
Start-Sleep -Milliseconds 25;
${pidGuardPs('$h', expectedPid)}
if ([ADPC]::GetForegroundWindow() -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false} | ConvertTo-Json -Compress; exit }
[ADPC]::mouse_event(${downFlag},0,0,0,[IntPtr]::Zero);
Start-Sleep -Milliseconds 25;
[ADPC]::mouse_event(${upFlag},0,0,0,[IntPtr]::Zero);
@{ok=$true; executed=$true} | ConvertTo-Json -Compress`;

/** Atomic foreground fence + SendKeys. */
const SENDKEYS_PS = (hwnd, expectedPid, keysLiteral) => `${PS_PRELUDE}
${NATIVE_CORE}
Add-Type -AssemblyName System.Windows.Forms;
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if ($h -eq [IntPtr]::Zero) { @{ok=$false; code="TARGET_IDENTITY_REQUIRED"; executed=$false} | ConvertTo-Json -Compress; exit }
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
$fg = [ADPC]::GetForegroundWindow();
if ($fg -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false; foreground=$fg.ToInt64()} | ConvertTo-Json -Compress; exit }
[System.Windows.Forms.SendKeys]::SendWait(${keysLiteral});
@{ok=$true; executed=$true} | ConvertTo-Json -Compress`;

/** ATOMIC target-bound paste keys: ensure keyboard focus inside the target,
 * verify the foreground fence, then Ctrl+V — all in ONE helper call so no
 * focus can be stolen between "focus check" and "keys sent". */
const PASTE_KEYS_PS = (hwnd, expectedPid) => `${PS_PRELUDE}
${NATIVE_CORE}
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
if ([ADPC]::GetForegroundWindow() -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false} | ConvertTo-Json -Compress; exit }
try {
  $ae = [System.Windows.Automation.AutomationElement];
  $focused = $ae::FocusedElement;
  $top = $focused;
  try {
    $w = [System.Windows.Automation.TreeWalker]::RawViewWalker;
    $p = $w.GetParent($top);
    while ($p -ne $null) {
      if ($p.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') { $top = $p; break }
      $p = $w.GetParent($p);
    }
  } catch { }
  $focusHwnd = 0; try { $focusHwnd = $top.Current.NativeWindowHandle } catch { }
  if ($focusHwnd -ne ${Math.trunc(Number(hwnd))}) {
    $root = $ae::FromHandle($h);
    $cond = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition($ae::IsKeyboardFocusableProperty, $true)),
      (New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
        (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)),
        (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Custom))
      ))
    );
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond);
    if ($el -ne $null) {
      ${pidGuardPs('$h', expectedPid)}
      try { $el.SetFocus() } catch { }
    }
  }
} catch { }
${pidGuardPs('$h', expectedPid)}
if ([ADPC]::GetForegroundWindow() -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false} | ConvertTo-Json -Compress; exit }
[System.Windows.Forms.SendKeys]::SendWait('^v');
@{ok=$true; executed=$true} | ConvertTo-Json -Compress`;

/** Clipboard read/write via the built-in cmdlets — empirically the reliable
 * route from the helper process (STA runspace reads return empty on PS 5.1
 * `-Command` payloads; user32 OpenClipboard from a windowless helper fails).
 * Text goes through psLiteral → no quoting/injection risk, Unicode intact. */
const CLIPBOARD_PS = (mode, textLiteral) => `${PS_PRELUDE}
if (${psLiteral(mode)} -eq 'read') {
  try { @{ok=$true; text=(Get-Clipboard -Raw)} | ConvertTo-Json -Compress }
  catch { @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
} else {
  try { Set-Clipboard -Value ${textLiteral}; @{ok=$true} | ConvertTo-Json -Compress }
  catch { @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
}`;

/** True UIA tree: ControlViewWalker recursion (never FindAll(Descendants)),
 * bounded depth/nodes/text, RuntimeId per node, IsPassword flag.
 * NOTE: output keys deliberately avoid AutomationElement member names
 * (AutomationId / ControlType / IsPassword / IsEnabled / IsOffscreen /
 * IsKeyboardFocusable) — PowerShell's adapted-object resolution would
 * otherwise hijack `$el.<key>` and return the adapted member instead of the
 * hashtable value, silently corrupting the tree. */
const UIA_TREE_PS = (hwnd, maxDepth, maxNodes, maxTextLen) => `${PS_PRELUDE}
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPUIA { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }
"@
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPUIA]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"} | ConvertTo-Json -Compress; exit }
$ae = [System.Windows.Automation.AutomationElement];
$root = $ae::FromHandle($h);
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker;
$maxDepth = ${Math.trunc(Number(maxDepth))}; $maxNodes = ${Math.trunc(Number(maxNodes))}; $maxText = ${Math.trunc(Number(maxTextLen))};
$flat = New-Object System.Collections.Generic.List[object];
$script:count = 0;
function TruncText($s) { if ($null -eq $s) { return '' }; $t = [string]$s; if ($t.Length -gt $maxText) { return $t.Substring(0, $maxText) }; return $t }
function Walk($el, $depth, $path) {
  if ($script:count -ge $maxNodes -or $depth -gt $maxDepth) { return }
  $script:count++;
  $cur = $el.Current;
  $rid = @(); try { $rid = @($cur.GetRuntimeId()) } catch { }
  $b = New-Object System.Windows.Rect; try { $b = $cur.BoundingRectangle } catch { }
  $pw = $false; try { $pw = $cur.IsPassword } catch { }
  $pats = New-Object System.Collections.Generic.List[string];
  foreach ($p in $el.GetSupportedPatterns()) { $pats.Add($p.ProgrammaticName.Split('.')[0]) }
  $idx = $path -join ',';
  $flat.Add(@{id=$idx; depth=$depth; elName=(TruncText $cur.Name); automationId=(TruncText $cur.AutomationId);
    ctlType=$cur.ControlType.ProgrammaticName; rid=$rid;
    rx=[int]$b.Left; ry=[int]$b.Top; rw=[int]$b.Width; rh=[int]$b.Height;
    isEnabled=$cur.IsEnabled; isOffscreen=$cur.IsOffscreen; canFocus=$cur.IsKeyboardFocusable;
    isPassword=$pw; pats=$pats});
  $i = 0;
  $child = $null; try { $child = $walker.GetFirstChild($el) } catch { }
  while ($child -ne $null -and $script:count -lt $maxNodes -and $depth -lt $maxDepth) {
    Walk $child ($depth + 1) ($path + @($i));
    $i++;
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}
Walk $root 0 @();
@{ok=$true; count=$script:count; truncated=($script:count -ge $maxNodes); elements=$flat} | ConvertTo-Json -Compress -Depth 5`;

/** Resolve an element by tree path, verify RuntimeId (STALE_ELEMENT — never a
 * fuzzy "most similar" match), then run one semantic pattern action. */
const ELEMENT_ACTION_PS = (hwnd, expectedPid, pathCsv, runtimeIdCsv, action, valueLiteral) => `${PS_PRELUDE}
${NATIVE_CORE}
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
$ae = [System.Windows.Automation.AutomationElement];
$root = $ae::FromHandle($h);
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker;
$el = $root;
$pathStr = ${psLiteral(pathCsv)};
if ($pathStr -ne '') {
  foreach ($s in $pathStr.Split(',')) {
    $idx = [int]$s;
    $c = $null; try { $c = $walker.GetFirstChild($el) } catch { }
    $j = 0;
    while ($c -ne $null -and $j -lt $idx) { try { $c = $walker.GetNextSibling($c) } catch { $c = $null }; $j++ }
    if ($c -eq $null) { @{ok=$false; code="STALE_ELEMENT"; reason="path-broken"} | ConvertTo-Json -Compress; exit }
    $el = $c;
  }
}
$expected = ${psLiteral(runtimeIdCsv)};
$actual = ''; try { $actual = (@($el.Current.GetRuntimeId()) -join ',') } catch { }
if ($expected -ne '' -and $actual -ne $expected) { @{ok=$false; code="STALE_ELEMENT"; reason="runtime-id-changed"} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', expectedPid)}
$act = ${psLiteral(action)};
$result = @{ok=$true; action=$act; verified=$false};
try {
  if ($act -eq 'invoke') {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
    if (-not $p) { @{ok=$false; code="PATTERN_UNAVAILABLE"; pattern="Invoke"} | ConvertTo-Json -Compress; exit }
    $p.Invoke();
  } elseif ($act -eq 'value') {
    $pw = $false; try { $pw = $el.Current.IsPassword } catch { }
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);
    if (-not $p) { @{ok=$false; code="PATTERN_UNAVAILABLE"; pattern="Value"} | ConvertTo-Json -Compress; exit }
    $el.SetFocus() | Out-Null;
    $p.SetValue(${valueLiteral});
    if (-not $pw) {
      try { $rb = [string]$p.Current.Value; $wb = ${valueLiteral}; $result.verified = ($rb -eq $wb) } catch { }
      $result.sensitive = $false;
    } else { $result.sensitive = $true }  # password: executed, NEVER read back
  } elseif ($act -eq 'toggle') {
    $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern);
    if (-not $p) { @{ok=$false; code="PATTERN_UNAVAILABLE"; pattern="Toggle"} | ConvertTo-Json -Compress; exit }
    $p.Toggle();
    try { $result.toggleState = $p.Current.ToggleState.ToString() } catch { }
  } elseif ($act -eq 'select') {
    $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);
    if (-not $p) { @{ok=$false; code="PATTERN_UNAVAILABLE"; pattern="SelectionItem"} | ConvertTo-Json -Compress; exit }
    $p.Select();
  } elseif ($act -eq 'scroll') {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern);
    if (-not $p) { @{ok=$false; code="PATTERN_UNAVAILABLE"; pattern="Scroll"} | ConvertTo-Json -Compress; exit }
    $dy = ${valueLiteral};
    try {
      if ($dy -lt 0) {
        try { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeDecrement) }
        catch { $p.SetScrollPercent([System.Windows.Automation.ScrollAmount]::NoAmount, -25) }
      } else {
        try { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeIncrement) }
        catch { $p.SetScrollPercent([System.Windows.Automation.ScrollAmount]::NoAmount, 25) }
      }
    } catch {
      # last resort: percentage-based scroll never throws on WPF ScrollViewers
      $p.SetScrollPercent([System.Windows.Automation.ScrollAmount]::NoAmount, $(if ($dy -lt 0) { -25 } else { 25 }));
    }
  } elseif ($act -eq 'focus') {
    $el.SetFocus();
  }
} catch {
  @{ok=$false; code="ELEMENT_ACTION_FAILED"; reason=$_.Exception.Message} | ConvertTo-Json -Compress; exit
}
$result | ConvertTo-Json -Compress`;

/** Virtual-screen full capture (negative origins included) with metadata. */
const FULL_SHOT_PS = (file) => `${PS_PRELUDE}
Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size);
$bmp.Save(${psLiteral(file)}, [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
$fg = 0;
@{ok=$true; originX=$vs.Left; originY=$vs.Top; width=$vs.Width; height=$vs.Height; captureMethod="VIRTUAL_SCREEN_COPY"} | ConvertTo-Json -Compress`;

/** Window capture: PrintWindow first; COPY_FROM_SCREEN fallback must say so;
 * minimized ⇒ MINIMIZED_WINDOW_UNCAPTURABLE unless an explicit restore was
 * authorized by the caller. */
const WINDOW_SHOT_PS = (hwnd, expectedPid, file, allowRestore) => `${PS_PRELUDE}
Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPShot {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static bool ValidateTarget(IntPtr h, uint expectedPid, out uint actualPid) {
    actualPid = 0;
    if (h == IntPtr.Zero || expectedPid == 0 || !IsWindow(h)) return false;
    GetWindowThreadProcessId(h, out actualPid);
    return actualPid == expectedPid;
  }
}
"@
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPShot]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"} | ConvertTo-Json -Compress; exit }
${shotPidGuardPs(expectedPid)}
if ([ADPShot]::IsIconic($h)) {
  if (${allowRestore ? '$true' : '$false'}) { [ADPShot]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 350 }
  else { @{ok=$false; code="MINIMIZED_WINDOW_UNCAPTURABLE"} | ConvertTo-Json -Compress; exit }
}
${shotPidGuardPs(expectedPid)}
$r = New-Object ADPShot+RECT; [ADPShot]::GetWindowRect($h, [ref]$r) | Out-Null;
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top;
if ($w -le 0 -or $hh -le 0) { @{ok=$false; code="INVALID_WINDOW_RECT"} | ConvertTo-Json -Compress; exit }
$bmp = New-Object System.Drawing.Bitmap($w, $hh);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$hdc = $g.GetHdc();
${shotPidGuardPs(expectedPid)}
$pw = [ADPShot]::PrintWindow($h, $hdc, 2);
$g.ReleaseHdc($hdc);
$method = '';
$occluded = $false;
if ($pw) { $method = 'PRINT_WINDOW' } else {
  ${shotPidGuardPs(expectedPid)}
  $g.Dispose(); $bmp.Dispose();
  $bmp = New-Object System.Drawing.Bitmap($w, $hh);
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)));
  $method = 'COPY_FROM_SCREEN';
  $occluded = ([ADPShot]::GetForegroundWindow() -ne $h);
}
$bmp.Save(${psLiteral(file)}, [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
@{ok=$true; width=$w; height=$hh; captureMethod=$method; occluded=$occluded; x=$r.Left; y=$r.Top} | ConvertTo-Json -Compress`;

const PROBE_DESKTOP_PS = `${PS_PRELUDE}
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId;
$fg = [ADPProbe]::GetForegroundWindow();
@{ok=$true; sessionId=$session; interactive=($session -gt 0 -and $fg -ne [IntPtr]::Zero)} | ConvertTo-Json -Compress`;

/* ------------------------------------------------------------------ manager */

class ComputerManager {
  /**
   * @param opts.sessions      ComputerSessionRegistry
   * @param opts.lock          DesktopInteractionLock (defaults to a fresh one)
   * @param opts.observations  ObservationStore (defaults to a fresh one)
   * @param opts.onProblem     ({severity, source, code, message, runId, relatedKey}) => void
   * @param opts.sensitiveAuthorizer  async ({sessionId, reason}) => boolean  (computer.sensitive_input)
   * @param opts.targetAuthorizer     async ({sessionId, windowRef}) => boolean (re-auth for new targets)
   * @param opts.clipboardFake injectable {read():Promise<string|null>, write(t):Promise<void>} (tests)
   */
  constructor(opts = {}) {
    this.sessions = opts.sessions || null;
    this.lock = opts.lock || new DesktopInteractionLock();
    this.observations = opts.observations || new ObservationStore();
    this.onProblem = opts.onProblem || (() => {});
    this.sensitiveAuthorizer = opts.sensitiveAuthorizer || null;
    this.targetAuthorizer = opts.targetAuthorizer || null;
    this.clipboardFake = opts.clipboardFake || null;
    this._history = [];
    this._tempFiles = new Set();
    this._clipboardTx = 0;          // open clipboard transactions (must end 0)
    this._clipboardBackup = null;   // text restored in finally even on cancel
    this.lastObservationAt = null;
    this.lastActionAt = null;
    this._groundingAbort = null;
  }

  /* ------------------------------------------------------------ auditing */

  /**
   * Bounded action audit. NEVER stores typed text / clipboard content /
   * passwords — only method, target identity, length and sensitivity flag.
   */
  recordAction(action, detail = {}, ok = true, error = null, meta = {}) {
    const entry = {
      actionId: 'ca_' + crypto.randomBytes(6).toString('hex'),
      action,
      sessionId: meta.sessionId || null,
      runId: meta.runId || null,
      rootRunId: meta.rootRunId || null,
      agentId: meta.agentId || null,
      targetHwnd: (detail && detail.hwnd != null) ? Number(detail.hwnd) : null,
      targetProcess: (detail && detail.process) || null,
      method: (detail && detail.method) || null,
      observationId: meta.observationId || null,
      outcome: ok ? (meta.verified ? 'VERIFIED' : 'EXECUTED') : 'FAILED',
      errorCode: ok ? null : String(error || 'COMPUTER_ERROR').slice(0, 60),
      detail: sanitizeDetail(detail),
      at: new Date().toISOString(),
      started: meta.started || Date.now(),
      durationMs: meta.started ? Date.now() - meta.started : null
    };
    this._history.unshift(entry);
    if (this._history.length > ACTION_HISTORY_LIMIT) this._history.length = ACTION_HISTORY_LIMIT;
    this.lastActionAt = entry.at;
    if (meta.sessionId && this.sessions) {
      const s = this.sessions.get(meta.sessionId);
      if (s) { s.actionCount++; s.lastAction = { type: action, at: entry.at, outcome: entry.outcome, errorCode: entry.errorCode }; s.lastErrorCode = entry.errorCode || s.lastErrorCode; }
    }
    if (!ok && entry.errorCode) this._reportProblem(entry.errorCode, `Computer 动作失败：${action}（${entry.errorCode}）`, meta);
    return entry;
  }

  history(limit = ACTION_HISTORY_LIMIT) { return this._history.slice(0, limit); }

  _reportProblem(code, message, meta = {}) {
    const PROBLEM_CODES = new Set([
      'AMBIGUOUS_WINDOW', 'STALE_WINDOW', 'FOREGROUND_CHANGED', 'STALE_OBSERVATION',
      'STALE_ELEMENT', 'TARGET_NOT_ALLOWED', 'COMPUTER_GROUNDING_LOW_CONFIDENCE',
      'COMPUTER_TIMEOUT', 'COMPUTER_CANCEL_FAILED', 'COMPUTER_RESIDUE',
      'FOREGROUND_NOT_ACQUIRED', 'MINIMIZED_WINDOW_UNCAPTURABLE'
    ]);
    if (!PROBLEM_CODES.has(code)) return;
    try {
      this.onProblem({
        severity: 'WARNING', source: 'Computer', code, message,
        runId: meta.runId || null, relatedKey: `computer:${code}`
      });
    } catch { /* problems must never break the runtime */ }
  }

  activeCount() { return psHost.activeCount(); }

  /** Central fail-closed target fence for every session-owned manager path. */
  _requireAuthorizedTarget(sessionId, target) {
    if (!sessionId) return { ok: true };
    if (!this.sessions) {
      return { ok: false, code: 'TARGET_AUTH_REQUIRED', error: 'Computer target authorizer is unavailable' };
    }
    if (!target || !Number(target.hwnd) || !Number(target.pid)) {
      return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: 'Target HWND and PID are required' };
    }
    return this.sessions.assertTargetAllowed(sessionId, target);
  }

  /* ------------------------------------------------------- availability */

  async availability() {
    if (process.platform !== 'win32') {
      return { status: 'UNSUPPORTED', reason: `platform ${process.platform} not supported`, checkedAt: new Date().toISOString() };
    }
    try {
      const probe = await runPs('$PSVersionTable.PSVersion.ToString()', { timeoutMs: 8000 });
      if (!probe.ok) return { status: 'ERROR', reason: probe.error, checkedAt: new Date().toISOString() };
      const win = await this.listWindows(10000);
      if (!win.ok) return { status: 'ERROR', reason: win.error, checkedAt: new Date().toISOString() };
      const desktop = await this.probeInteractiveDesktop();
      return {
        status: 'AVAILABLE', reason: 'probe ok', checkedAt: new Date().toISOString(),
        interactiveDesktop: !!(desktop && desktop.interactive),
        sessionCount: this.sessions ? this.sessions.activeCount() : 0
      };
    } catch (e) {
      return { status: 'ERROR', reason: String((e && e.message) || e), checkedAt: new Date().toISOString() };
    }
  }

  /** Session 0 / headless truth — Computer production tests cannot PASS there. */
  async probeInteractiveDesktop() {
    if (process.platform !== 'win32') return { ok: false, interactive: false, reason: 'UNSUPPORTED' };
    const r = await runPs(PROBE_DESKTOP_PS, { timeoutMs: 8000 });
    if (!r.ok) return { ok: false, interactive: false, reason: r.error };
    const d = r.data || {};
    return { ok: true, interactive: !!d.interactive, sessionId: Number(d.sessionId) || 0 };
  }

  /* ------------------------------------------------------------- windows */

  /** WindowRef discovery (stable identity; legacy fields kept for the bridge). */
  async listWindows(timeoutMs = 30000, opts = {}) {
    const r = await winId.listWindowRefs({ timeoutMs, sessionId: opts.sessionId || null, signal: opts.signal || null });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    return { ok: true, windows: r.windows };
  }

  /**
   * Resolve one WindowRef. Ambiguity FAILS CLOSED — never picks the first.
   * @param {object} q { hwnd | title | pid }
   */
  async resolveWindow(q = {}, opts = {}) {
    const list = await this.listWindows(15000, opts);
    if (!list.ok) return list;
    const r = winId.resolveFromList(list.windows, q);
    if (!r.ok) {
      if (r.code === 'AMBIGUOUS_WINDOW') this._reportProblem('AMBIGUOUS_WINDOW', r.error, opts);
      return r;
    }
    return r;
  }

  /**
   * Verified focus: SetForegroundWindow → bounded wait → GetForegroundWindow
   * comparison. Anything else is FOREGROUND_NOT_ACQUIRED.
   */
  async focusWindow(title, opts = {}) {
    // Legacy callers pass a title; P3 identity still requires an exact resolve.
    const res = typeof title === 'object' && title !== null
      ? { ok: true, window: title }
      : await this.resolveWindow({ title }, opts);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    return this.focusWindowRef(res.window, opts);
  }

  async focusWindowRef(ref, opts = {}) {
    if (!ref || !ref.hwnd || !ref.pid) return { ok: false, error: '缺少窗口 HWND + PID 身份', code: 'TARGET_IDENTITY_REQUIRED', executed: false };
    const authorized = this._requireAuthorizedTarget(opts.sessionId || null, ref);
    if (!authorized.ok) return { ...authorized, executed: false };
    const started = Date.now();
    const r = await runPs(FOCUS_PS(ref.hwnd, ref.pid, opts.verifyMs || 1200), {
      timeoutMs: opts.timeoutMs || 12000, sessionId: opts.sessionId || null, signal: opts.signal || null
    });
    if (!r.ok) {
      this.recordAction('focus_window', { hwnd: ref.hwnd, process: ref.processName, title: ref.title, method: 'set_foreground' }, false, r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', opts);
      return { ok: false, error: r.timedOut ? '聚焦超时' : r.error, code: r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR' };
    }
    const d = r.data || {};
    if (!d.ok) {
      this._reportProblem(d.code || 'FOREGROUND_NOT_ACQUIRED', `聚焦窗口「${ref.title}」失败`, opts);
      this.recordAction('focus_window', { hwnd: ref.hwnd, process: ref.processName, title: ref.title, method: 'set_foreground' }, false, d.code || 'FOREGROUND_NOT_ACQUIRED', opts);
      return { ok: false, error: '无法把窗口置于前台（可能被其他窗口抢占）', code: d.code || 'FOREGROUND_NOT_ACQUIRED', foreground: Number(d.foreground) || 0 };
    }
    this.recordAction('focus_window', { hwnd: ref.hwnd, process: ref.processName, title: ref.title, method: 'set_foreground' }, true, null, { ...opts, started, verified: true });
    return { ok: true, hwnd: ref.hwnd, pid: ref.pid, title: ref.title, verified: true };
  }

  /* --------------------------------------------------------- observations */

  /**
   * Observe = WindowRef validation + true UIA tree (+ optional screenshot).
   * Returns the observationId every interactive action must present.
   */
  async observe(q = {}, opts = {}) {
    const res = q.hwnd || q.title || q.pid ? await this.resolveWindow(q, opts) : { ok: false, code: 'NO_TARGET' };
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    const ref = res.window;
    const probe = await winId.validateWindowRef(ref, { sessionId: opts.sessionId || null, signal: opts.signal || null });
    if (!probe.ok) return { ok: false, error: probe.error, code: probe.code };

    const tree = await this._fetchUiTree(ref.hwnd, opts);
    if (!tree.ok) return { ok: false, error: tree.error, code: tree.code };

    let screenshot = null;
    if (opts.screenshot !== false) {
      const shot = await this.screenshotWindowRef(ref, { sessionId: opts.sessionId || null, signal: opts.signal || null });
      if (shot.ok) screenshot = shot;
    }

    const elements = tree.elements.map(el => ({
      elementRef: makeElementRef({ runtimeId: el.runtimeId, path: el.path, automationId: el.automationId, controlType: el.controlType }),
      path: el.path, name: el.name, automationId: el.automationId, controlType: el.controlType,
      runtimeId: el.runtimeId, boundingRect: el.boundingRect, enabled: el.enabled,
      offscreen: el.offscreen, focusable: el.focusable, isPassword: el.isPassword, patterns: el.patterns
    }));

    const obs = this.observations.create({
      sessionId: opts.sessionId || null,
      windowRef: ref,
      windowRect: probe.rect,
      clientRect: probe.rect,
      dpi: ref.dpi || 96,
      screenshotFingerprint: screenshot ? String(screenshot.width) + 'x' + String(screenshot.height) : null,
      uiFingerprint: crypto.createHash('sha1').update(JSON.stringify(tree.elements.map(e => [e.controlType, e.name, e.automationId]))).digest('hex').slice(0, 16),
      elements,
      ttlMs: opts.ttlMs
    });
    this.lastObservationAt = new Date().toISOString();
    if (opts.sessionId && this.sessions) {
      const s = this.sessions.get(opts.sessionId);
      if (s) s.observationCount++;
    }
    return {
      ok: true,
      observationId: obs.observationId,
      windowRef: ref,
      windowRect: probe.rect,
      dpi: ref.dpi || 96,
      foreground: probe.foreground,
      expiresAt: obs.expiresAt,
      elementCount: elements.length,
      truncated: tree.truncated,
      elements,
      screenshot: screenshot ? { data_url: screenshot.data_url, width: screenshot.width, height: screenshot.height, captureMethod: screenshot.captureMethod } : null
    };
  }

  async _fetchUiTree(hwnd, opts = {}, bounds = {}) {
    const r = await runPs(UIA_TREE_PS(hwnd, bounds.maxDepth || 6, bounds.maxNodes || 1000, bounds.maxTextLen || 120), {
      timeoutMs: opts.timeoutMs || 20000, sessionId: opts.sessionId || null, signal: opts.signal || null
    });
    if (!r.ok) return { ok: false, error: r.timedOut ? 'UIA 读取超时' : r.error, code: r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR' };
    const d = r.data || {};
    if (d.ok === false) return { ok: false, error: '窗口不可读', code: d.code || 'UIA_ERROR' };
    const raw = Array.isArray(d.elements) ? d.elements : (d.elements ? [d.elements] : []);
    const elements = raw.map(el => ({
      path: String(el.id == null ? '' : el.id).split(',').filter(s => s !== '').map(Number),
      depth: Number(el.depth) || 0,
      name: String(el.elName || ''),
      automationId: String(el.automationId || ''),
      controlType: String(el.ctlType || '').replace('ControlType.', ''),
      runtimeId: Array.isArray(el.rid) ? el.rid.map(Number) : (el.rid != null ? [Number(el.rid)] : []),
      boundingRect: { x: Number(el.rx) || 0, y: Number(el.ry) || 0, width: Number(el.rw) || 0, height: Number(el.rh) || 0 },
      enabled: el.isEnabled !== false,
      offscreen: !!el.isOffscreen,
      focusable: !!el.canFocus,
      isPassword: !!el.isPassword,
      patterns: Array.isArray(el.pats) ? el.pats : (el.pats ? [el.pats] : [])
    }));
    return { ok: true, elements, truncated: !!d.truncated, count: Number(d.count) || elements.length };
  }

  /** Legacy UI tree tool shape, now a TRUE tree (bounded). */
  async getUiTree(title, opts = {}) {
    const q = typeof title === 'object' ? title : { title };
    const res = await this.resolveWindow(q, opts);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    const tree = await this._fetchUiTree(res.window.hwnd, opts);
    if (!tree.ok) return tree;
    // rebuild nested shape for display
    const byPath = new Map();
    const roots = [];
    for (const el of tree.elements) {
      const node = { elementRef: makeElementRef({ runtimeId: el.runtimeId, path: el.path, automationId: el.automationId, controlType: el.controlType }), name: el.name, type: el.controlType, automationId: el.automationId, isPassword: el.isPassword, children: [] };
      byPath.set(el.path.join(','), node);
      const parentPath = el.path.slice(0, -1).join(',');
      const parent = byPath.get(parentPath);
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return { ok: true, nodes: tree.count, truncated: tree.truncated, tree: roots[0] || null, elements: tree.elements };
  }

  /* -------------------------------------------------------------- actions */

  /**
   * Pre-action fence shared by every mutation:
   * session alive → target allowed → observation fresh → geometry unchanged.
   */
  async _preAction({ observationId, sessionId, target, opts = {} }) {
    if (sessionId && this.sessions) {
      const s = this.sessions.get(sessionId);
      if (!s) return { ok: false, code: 'SESSION_NOT_FOUND', error: 'Computer 会话不存在' };
      if (['CANCELLED', 'COMPLETED', 'FAILED'].includes(s.status)) return { ok: false, code: 'SESSION_TERMINATED', error: `会话已终态（${s.status}），动作 exec=0` };
      if (target) {
        const allowed = this.sessions.assertTargetAllowed(sessionId, target);
        if (!allowed.ok) return allowed;
      }
    }
    if (!observationId) return { ok: false, code: 'STALE_OBSERVATION', error: '交互动作必须携带 observationId' };
    const obs = this.observations.get(observationId);
    if (!obs) return { ok: false, code: 'STALE_OBSERVATION', error: '观察不存在或已回收' };
    if (sessionId && obs.sessionId !== sessionId) {
      return { ok: false, code: 'SESSION_MISMATCH', error: '观察不属于该会话' };
    }
    // P3 Closure (C3): EVERY mutation is target-fenced — the fence check no
    // longer depends on the caller passing an explicit `target`. The
    // observation's own WindowRef is the identity being mutated, so it must be
    // one of this session's authorized windows (covers legacy compat paths
    // that resolve + observe internally without going through bindTarget).
    if (sessionId && this.sessions && obs.windowRef) {
      const allowed = this.sessions.assertTargetAllowed(sessionId, obs.windowRef);
      if (!allowed.ok) return allowed;
    }
    const probe = await winId.validateWindowRef(obs.windowRef, { sessionId, signal: opts.signal || null });
    const v = this.observations.validate(observationId, probe, { requireForeground: false });
    if (!v.ok) return v;
    return { ok: true, observation: obs, probe };
  }

  /**
   * Production click: observationId + normalized 0..1 coordinates. The backend
   * converts to physical pixels and enforces the target bounds fence.
   */
  async clickObserved({ observationId, normalizedX, normalizedY, button = 'left', sessionId = null }, opts = {}) {
    const started = Date.now();
    const pre = await this._preAction({ observationId, sessionId, opts });
    if (!pre.ok) {
      this.recordAction('click', { method: 'observed' }, false, pre.code, { sessionId, observationId, started });
      return { ok: false, code: pre.code, error: pre.error, executed: false };
    }
    const { observation, probe } = pre;
    const conv = coords.normalizedToScreenPhysical(normalizedX, normalizedY, { ...probe.rect, dpiScale: 1 });
    if (!conv.ok) {
      this.recordAction('click', { method: 'observed' }, false, 'INVALID_NORMALIZED', { sessionId, observationId, started });
      return { ok: false, code: 'INVALID_NORMALIZED', error: '归一化坐标必须为 0..1 的有限数', executed: false };
    }
    if (!coords.withinBounds(conv.x, conv.y, probe.rect)) {
      this.recordAction('click', { method: 'observed', hwnd: observation.windowRef.hwnd }, false, 'COMPUTER_TARGET_BOUNDS_VIOLATION', { sessionId, observationId, started });
      return { ok: false, code: 'COMPUTER_TARGET_BOUNDS_VIOLATION', error: '目标坐标越出窗口边界，拒绝执行', executed: false };
    }
    const flags = button === 'right' ? [8, 16] : [2, 4];
    const r = await runPs(CLICK_PS(observation.windowRef.hwnd, observation.windowRef.pid, conv.x, conv.y, flags[0], flags[1]), {
      timeoutMs: opts.timeoutMs || 10000, sessionId, signal: opts.signal || null
    });
    if (!r.ok) {
      this.recordAction('click', { hwnd: observation.windowRef.hwnd, method: 'observed' }, false, r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', { sessionId, observationId, started });
      return { ok: false, code: r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', error: r.error, executed: false };
    }
    const d = r.data || {};
    if (!d.executed) {
      this._reportProblem(d.code || 'FOREGROUND_CHANGED', '点击前前台校验失败', { sessionId });
      this.recordAction('click', { hwnd: observation.windowRef.hwnd, method: 'observed' }, false, d.code || 'FOREGROUND_CHANGED', { sessionId, observationId, started });
      return { ok: false, code: d.code || 'FOREGROUND_CHANGED', error: '前台窗口已被切换，点击未执行', executed: false };
    }
    this.recordAction('click', { hwnd: observation.windowRef.hwnd, process: observation.windowRef.processName, method: 'observed', x: conv.x, y: conv.y }, true, null, { sessionId, observationId, started });
    return { ok: true, executed: true, outcome: 'EXECUTED', x: conv.x, y: conv.y, button };
  }

  /** Generic element-action entry (invoke/value/toggle/select/scroll/focus). */
  async _elementAction(action, { observationId, elementRef, value = '', sessionId = null, sensitive = false }, opts = {}) {
    const started = Date.now();
    const pre = await this._preAction({ observationId, sessionId, opts });
    if (!pre.ok) {
      this.recordAction(action, { method: 'uia' }, false, pre.code, { sessionId, observationId, started });
      return { ok: false, code: pre.code, error: pre.error, executed: false };
    }
    const { observation } = pre;
    const parsed = require('./computer/computerObservation').parseElementRef(elementRef);
    if (!parsed) return { ok: false, code: 'STALE_ELEMENT', error: 'elementRef 非法', executed: false };
    const known = observation.elements.find(e => e.elementRef === elementRef);
    if (known && known.isPassword && action === 'value' && !sensitive) {
      // Sensitive fields need explicit authorization — never implied.
      const auth = this.sensitiveAuthorizer ? await this.sensitiveAuthorizer({ sessionId, reason: 'password_input' }) : false;
      if (!auth) {
        this.recordAction(action, { method: 'uia', sensitive: true }, false, 'SENSITIVE_INPUT_DENIED', { sessionId, observationId, started });
        return { ok: false, code: 'SENSITIVE_INPUT_DENIED', error: '向密码框写入需要 computer.sensitive_input 显式授权', executed: false };
      }
    }
    const r = await runPs(ELEMENT_ACTION_PS(observation.windowRef.hwnd, observation.windowRef.pid, parsed.path.join(','), parsed.runtimeId.join(','), action, action === 'scroll' ? Number(value) || 1 : psLiteral(String(value == null ? '' : value))), {
      timeoutMs: opts.timeoutMs || 12000, sessionId, signal: opts.signal || null
    });
    if (!r.ok) {
      this.recordAction(action, { method: 'uia' }, false, r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', { sessionId, observationId, started });
      return { ok: false, code: r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', error: r.error, executed: false };
    }
    const d = r.data || {};
    if (d.ok === false) {
      if (d.code === 'STALE_ELEMENT') this._reportProblem('STALE_ELEMENT', '元素已变化，动作未执行', { sessionId });
      this.recordAction(action, { method: 'uia', sensitive: !!d.sensitive }, false, d.code || 'ELEMENT_ACTION_FAILED', { sessionId, observationId, started });
      return { ok: false, code: d.code || 'ELEMENT_ACTION_FAILED', error: d.reason || '元素动作失败', executed: false };
    }
    const verified = !!d.verified;
    this.recordAction(action, { hwnd: observation.windowRef.hwnd, method: 'uia', sensitive: !!d.sensitive, valueLength: action === 'value' ? String(value == null ? '' : value).length : undefined }, true, null, { sessionId, observationId, started, verified });
    return {
      ok: true, executed: true,
      // EXECUTED vs VERIFIED truth: passwords are never read back.
      outcome: d.sensitive ? 'EXECUTED' : (verified ? 'VERIFIED' : 'EXECUTED'),
      verified, sensitive: !!d.sensitive, toggleState: d.toggleState || null
    };
  }

  invokeElement(args, opts) { return this._elementAction('invoke', args, opts); }
  toggleElement(args, opts) { return this._elementAction('toggle', args, opts); }
  selectElement(args, opts) { return this._elementAction('select', args, opts); }
  scrollElement(args, opts) { return this._elementAction('scroll', args, opts); }
  setElementValue(args, opts) { return this._elementAction('value', args, opts); }

  /* ----------------------------------------------------------- input chain */

  async _readClipboard(opts = {}) {
    if (this.clipboardFake) return this.clipboardFake.read();
    const r = await runPs(CLIPBOARD_PS('read', 'null'), { timeoutMs: 10000, sessionId: opts.sessionId || null, signal: opts.signal || null });
    return r.ok ? String((r.data || {}).text || '') : null;
  }

  async _writeClipboard(text, opts = {}) {
    if (this.clipboardFake) { await this.clipboardFake.write(text); return true; }
    const r = await runPs(CLIPBOARD_PS('write', psLiteral(text)), { timeoutMs: 10000, sessionId: opts.sessionId || null, signal: opts.signal || null });
    return !!(r.ok && r.data && r.data.ok !== false);
  }

  /**
   * Target-bound clipboard paste with restore-in-finally:
   * read current → set temp → paste into VERIFIED foreground → restore original
   * (also on cancel/error). The transaction counter must return to 0.
   *
   * P3 Closure (C9) — cancel truth at every precise point:
   *   A. after backup read        → no mutation happened, settle clean
   *   B. after temporary write    → finally restores the original
   *   C. during focus/paste helper→ signal kills the helper, finally restores
   *   D. paste ok but pre-restore → finally restores before the caller sees ok
   * Every path ends with clipboard == original marker, tx == 0, backup = null.
   */
  async pasteToTarget({ target, text, sessionId = null }, opts = {}) {
    const started = Date.now();
    if (!target || !target.hwnd || !target.pid) {
      return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: '粘贴目标必须包含 HWND + PID', executed: false };
    }
    const authorized = this._requireAuthorizedTarget(sessionId, target);
    if (!authorized.ok) return { ...authorized, executed: false };
    const signal = opts.signal || null;
    const aborted = () => !!(signal && signal.aborted);
    const backup = await this._readClipboard(opts);
    // Checkpoint A — cancel after backup read: nothing was overwritten yet.
    if (aborted()) {
      this.recordAction('paste', { method: 'clipboard' }, false, 'CANCELLED', { sessionId, started });
      return { ok: false, code: 'CANCELLED', error: '已取消（剪贴板未改动）', executed: false };
    }
    this._clipboardTx++;
    this._clipboardBackup = backup;
    try {
      const wrote = await this._writeClipboard(String(text == null ? '' : text), opts);
      if (!wrote) {
        this.recordAction('paste', { method: 'clipboard' }, false, 'CLIPBOARD_WRITE_FAILED', { sessionId, started });
        return { ok: false, code: 'CLIPBOARD_WRITE_FAILED', error: '写入剪贴板失败', executed: false };
      }
      // Checkpoint B — cancel after the temporary write: the finally block
      // still restores the user's original content.
      if (aborted()) {
        this.recordAction('paste', { method: 'clipboard' }, false, 'CANCELLED', { sessionId, started });
        return { ok: false, code: 'CANCELLED', error: '已取消（剪贴板将恢复）', executed: false };
      }
      // Atomic: focus-inside-target + foreground fence + Ctrl+V in ONE helper —
      // nothing can steal focus between the check and the keys.
      // (Test path with an injected fake clipboard keeps the stub-able pressKeys...)
      let paste;
      if (this.clipboardFake) {
        paste = await this.pressKeys('^v', { foregroundHwnd: target && target.hwnd, foregroundPid: target && target.pid, sessionId, signal });
      } else {
        // Checkpoint C — cancellation mid paste helper: the signal kills the
        // helper via psHost; settle is honest; finally restores.
        const pasteR = await runPs(PASTE_KEYS_PS(target && target.hwnd ? target.hwnd : 0, target && target.pid ? target.pid : 0), {
          timeoutMs: opts.timeoutMs || 15000, sessionId, signal
        });
        paste = (!pasteR.ok)
          ? { ok: false, executed: false, code: pasteR.cancelled ? 'CANCELLED' : (pasteR.timedOut ? 'COMPUTER_TIMEOUT' : 'PASTE_FAILED'), error: pasteR.error }
          : (pasteR.data || {});
      }
      if (!paste.ok || paste.executed === false) {
        this.recordAction('paste', { method: 'clipboard', hwnd: target && target.hwnd }, false, paste.code || 'PASTE_FAILED', { sessionId, started });
        return { ok: false, code: paste.code || 'PASTE_FAILED', error: paste.error || '粘贴失败', executed: false };
      }
      // Checkpoint D — paste succeeded; the clipboard restore below (finally)
      // still runs BEFORE this result can be consumed by any late action.
      this.recordAction('paste', { hwnd: target && target.hwnd, process: target && target.processName, method: 'clipboard', textLength: String(text == null ? '' : text).length }, true, null, { sessionId, started, verified: false });
      return { ok: true, executed: true, outcome: 'EXECUTED', method: 'clipboard' };
    } finally {
      // Restore the user's clipboard — success, failure OR cancel.
      // The RESTORE itself must never be cancelled by the caller's signal:
      // an aborted run still owns the guarantee "clipboard == original".
      // (The signal already killed the paste helper; cleanup runs fenced-off.)
      const restoreOpts = { ...opts, signal: null };
      try { await this._writeClipboard(backup == null ? '' : String(backup), restoreOpts); } catch { /* best effort */ }
      this._clipboardTx--;
      this._clipboardBackup = null;
    }
  }

  /** SendKeys with a foreground fence (never to unknown focus). */
  async pressKeys(keys, opts = {}) {
    const started = Date.now();
    const hwnd = opts.foregroundHwnd != null ? Math.trunc(Number(opts.foregroundHwnd)) : 0;
    const pid = opts.foregroundPid != null ? Math.trunc(Number(opts.foregroundPid)) : 0;
    if (!hwnd || !pid) {
      return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: '按键目标必须包含 HWND + PID', executed: false };
    }
    const authorized = this._requireAuthorizedTarget(opts.sessionId || null, { hwnd, pid });
    if (!authorized.ok) return { ...authorized, executed: false };
    const r = await runPs(SENDKEYS_PS(hwnd, pid, psLiteral(String(keys == null ? '' : keys))), {
      timeoutMs: opts.timeoutMs || 10000, sessionId: opts.sessionId || null, signal: opts.signal || null
    });
    if (!r.ok) {
      this.recordAction('key', { method: 'sendkeys', keysLength: String(keys || '').length }, false, r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR', { sessionId: opts.sessionId, started });
      return { ok: false, error: r.error, executed: false, code: r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR' };
    }
    const d = r.data || {};
    if (!d.executed) {
      this._reportProblem(d.code || 'FOREGROUND_CHANGED', '按键前前台校验失败', { sessionId: opts.sessionId });
      this.recordAction('key', { method: 'sendkeys', keysLength: String(keys || '').length }, false, d.code || 'FOREGROUND_CHANGED', { sessionId: opts.sessionId, started });
      return { ok: false, code: d.code || 'FOREGROUND_CHANGED', error: '前台窗口已变化，按键未发送', executed: false };
    }
    this.recordAction('key', { method: 'sendkeys', keysLength: String(keys || '').length, hwnd: hwnd || null }, true, null, { sessionId: opts.sessionId, started });
    return { ok: true, executed: true, outcome: 'EXECUTED' };
  }

  /** Type literal text into a VERIFIED target: UIA Value > paste > SendKeys. */
  async typeTextToTarget({ target, text, submit = false, sessionId = null }, opts = {}) {
    if (!target || !target.hwnd || !target.pid) return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: '输入必须绑定已验证的 HWND + PID 目标窗口', executed: false };
    const authorized = this._requireAuthorizedTarget(sessionId, target);
    if (!authorized.ok) return { ...authorized, executed: false };
    // 1) UIA ValuePattern straight into the control
    const focus = await this.focusWindowRef(target, { sessionId, signal: opts.signal || null });
    if (!focus.ok) return { ok: false, code: focus.code || 'FOREGROUND_NOT_ACQUIRED', error: focus.error, executed: false };
    const obs = await this.observe({ hwnd: target.hwnd }, { sessionId, screenshot: false, signal: opts.signal || null, ttlMs: 8000 });
    if (obs.ok) {
      const edit = obs.elements.find(e => !e.isPassword && !e.offscreen && e.enabled && (e.patterns.includes('Value')) && ['Edit', 'Document'].includes(e.controlType));
      if (edit) {
        const r = await this.setElementValue({ observationId: obs.observationId, elementRef: edit.elementRef, value: String(text == null ? '' : text), sessionId }, opts);
        if (r.ok) {
          if (submit) await this.pressKeys('~', { foregroundHwnd: target.hwnd, foregroundPid: target.pid, sessionId, signal: opts.signal || null });
          return { ...r, method: 'uia-value' };
        }
      }
    }
    // 2) clipboard paste (restore guaranteed)
    const paste = await this.pasteToTarget({ target, text, sessionId }, opts);
    if (paste.ok) {
      if (submit) await this.pressKeys('~', { foregroundHwnd: target.hwnd, foregroundPid: target.pid, sessionId, signal: opts.signal || null });
      return paste;
    }
    if (paste.code === 'CANCELLED') return paste; // a cancelled paste never falls through to more input
    // 3) SendKeys fallback (still foreground-fenced)
    const body = escapeSendKeys(String(text == null ? '' : text).replace(/\r?\n/g, ' '));
    const keys = await this.pressKeys(body + (submit ? '~' : ''), { foregroundHwnd: target.hwnd, foregroundPid: target.pid, sessionId, signal: opts.signal || null });
    if (keys.ok) return { ...keys, method: 'sendkeys' };
    return keys;
  }

  /* ----------------------------------------------------------- screenshots */

  _trackTemp(file) { this._tempFiles.add(file); return file; }
  _untrackTemp(file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    this._tempFiles.delete(file);
  }
  tempResidue() {
    // Re-check reality: files may have been deleted out from under us.
    for (const f of [...this._tempFiles]) { if (!fs.existsSync(f)) this._tempFiles.delete(f); }
    return this._tempFiles.size;
  }
  cleanupTemp() { for (const f of [...this._tempFiles]) this._untrackTemp(f); return this.tempResidue(); }

  /**
   * P3 Closure (C8/C8.1) — PNG downsample owned by psHost: sessionId,
   * AbortSignal, timeout and truthful cancellation like every other helper.
   * The `.small.png` intermediate is tracked by the manager temp registry and
   * removed on success, failure, timeout AND cancel — residue = 0.
   * @returns {Promise<string|null>} base64 of the downsampled PNG (null = keep original)
   */
  async _downsamplePng(file, w, h, opts = {}) {
    const out = file + '.small.png';
    this._trackTemp(out);
    try {
      const script = `${PS_PRELUDE}
Add-Type -AssemblyName System.Drawing;
$src = [System.Drawing.Image]::FromFile(${psLiteral(file)});
$dst = New-Object System.Drawing.Bitmap(${Math.trunc(w)}, ${Math.trunc(h)});
$g = [System.Drawing.Graphics]::FromImage($dst);
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
$g.DrawImage($src, 0, 0, ${Math.trunc(w)}, ${Math.trunc(h)});
$dst.Save(${psLiteral(out)}, [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $dst.Dispose(); $src.Dispose();
@{ok=$true} | ConvertTo-Json -Compress`;
      const r = await runPs(script, { timeoutMs: opts.timeoutMs || 15000, sessionId: opts.sessionId || null, signal: opts.signal || null });
      if (!r.ok) return null; // timeout / cancel / crash → original stays, temp cleaned below
      const d = r.data || {};
      if (d.ok === false) return null;
      return fs.readFileSync(out).toString('base64');
    } catch { return null; } finally { this._untrackTemp(out); }
  }

  /** Full virtual desktop (multi-monitor incl. negative origins) + metadata. */
  async screenshot(opts = {}) {
    const file = this._trackTemp(path.join(os.tmpdir(), 'adp_shot_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '.png'));
    try {
      const r = await runPs(FULL_SHOT_PS(file), { timeoutMs: opts.timeoutMs || 20000, sessionId: opts.sessionId || null, signal: opts.signal || null });
      if (!r.ok) return { ok: false, error: r.error };
      const d = r.data || {};
      const b64 = fs.readFileSync(file).toString('base64');
      this.recordAction('screenshot', { method: d.captureMethod || 'VIRTUAL_SCREEN_COPY' }, true, null, { sessionId: opts.sessionId });
      return {
        ok: true, data_url: 'data:image/png;base64,' + b64,
        originX: Number(d.originX) || 0, originY: Number(d.originY) || 0,
        width: Number(d.width) || 0, height: Number(d.height) || 0,
        captureMethod: d.captureMethod || 'VIRTUAL_SCREEN_COPY'
      };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally { this._untrackTemp(file); }
  }

  /** Legacy signature (title) → resolve → hardened capture. */
  async screenshotWindow(title, opts = {}) {
    if (!title) return this.screenshot(opts);
    const q = typeof title === 'object' ? title : { title };
    const res = await this.resolveWindow(q, opts);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    return this.screenshotWindowRef(res.window, opts);
  }

  /**
   * Hardened window capture: PrintWindow first, honest captureMethod fallback,
   * minimized ⇒ MINIMIZED_WINDOW_UNCAPTURABLE (no silent restore of user
   * windows), oversized ⇒ downsampled vision copy.
   */
  async screenshotWindowRef(ref, opts = {}) {
    if (!ref || !ref.hwnd || !ref.pid) return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: '缺少窗口 HWND + PID 身份' };
    const authorized = this._requireAuthorizedTarget(opts.sessionId || null, ref);
    if (!authorized.ok) return authorized;
    if (ref.minimized && !opts.allowRestore) {
      return { ok: false, code: 'MINIMIZED_WINDOW_UNCAPTURABLE', error: '窗口已最小化，无法可靠截图（恢复窗口需显式授权）' };
    }
    const file = this._trackTemp(path.join(os.tmpdir(), 'adp_win_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '.png'));
    try {
      const r = await runPs(WINDOW_SHOT_PS(ref.hwnd, ref.pid, file, !!opts.allowRestore), {
        timeoutMs: opts.timeoutMs || 20000, sessionId: opts.sessionId || null, signal: opts.signal || null
      });
      if (!r.ok) return { ok: false, error: r.timedOut ? '截图超时' : r.error, code: r.timedOut ? 'COMPUTER_TIMEOUT' : undefined };
      const d = r.data || {};
      if (d.ok === false) {
        if (d.code === 'MINIMIZED_WINDOW_UNCAPTURABLE') this._reportProblem(d.code, '最小化窗口拒绝截图', { sessionId: opts.sessionId });
        return { ok: false, code: d.code || 'CAPTURE_FAILED', error: '窗口截图失败' };
      }
      let b64 = fs.readFileSync(file).toString('base64');
      let width = Number(d.width) || 0, height = Number(d.height) || 0;
      let downsampled = false;
      if ((width * height) > MAX_CAPTURE_PIXELS || width > MAX_VISION_DIM * 2 || height > MAX_VISION_DIM * 2) {
        // vision copy: cap the longest side to keep model calls affordable
        const scale = Math.min(1, MAX_VISION_DIM / Math.max(width, height));
        const small = await this._downsamplePng(file, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), {
          sessionId: opts.sessionId || null, signal: opts.signal || null
        });
        if (small) { b64 = small; downsampled = true; }
      }
      this.recordAction('screenshot', { hwnd: ref.hwnd, process: ref.processName, method: d.captureMethod }, true, null, { sessionId: opts.sessionId });
      return {
        ok: true, data_url: 'data:image/png;base64,' + b64,
        width, height, captureMethod: d.captureMethod, occluded: !!d.occluded,
        downsampled, x: Number(d.x) || 0, y: Number(d.y) || 0, title: ref.title
      };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally { this._untrackTemp(file); }
  }

  /* --------------------------------------------------- legacy compat layer */

  /** Legacy typeText: foreground-fenced SendKeys when a target is known. */
  async typeText(text, o = {}) {
    const body = escapeSendKeys(String(text == null ? '' : text).replace(/\r?\n/g, ' '));
    return this.pressKeys(body + (o.submit ? '~' : ''), { foregroundHwnd: o.foregroundHwnd, foregroundPid: o.foregroundPid, sessionId: o.sessionId });
  }

  async setClipboard(text, opts = {}) {
    const ok = await this._writeClipboard(String(text == null ? '' : text), opts);
    return ok ? { ok: true } : { ok: false, error: '写入剪贴板失败' };
  }

  async readClipboard(opts = {}) {
    const t = await this._readClipboard(opts);
    return t == null ? { ok: false, error: '读取剪贴板失败' } : { ok: true, text: t };
  }

  /** Legacy UIA value write — now via resolved WindowRef (ambiguous fails). */
  async setControlValue(title, text, o = {}) {
    const res = o.hwnd && o.pid
      ? { ok: true, window: { hwnd: Number(o.hwnd), pid: Number(o.pid), title: String(title || ''), processName: o.processName || '' } }
      : await this.resolveWindow(o.hwnd ? { hwnd: o.hwnd } : { title }, o);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    const target = res.window;
    const r = await this.typeTextToTarget({ target, text, sessionId: o.sessionId || null }, o);
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    return { ok: true, via: r.method || 'uia-value', name: '', automationId: o.automationId || '' };
  }

  /** Legacy text dump — IsPassword elements' values are NEVER included. */
  async getWindowText(title, maxNodes = 400, opts = {}) {
    const q = typeof title === 'object' ? title : { title };
    const res = await this.resolveWindow(q, opts);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    const tree = await this._fetchUiTree(res.window.hwnd, { ...opts, maxNodes });
    if (!tree.ok) return { ok: false, error: tree.error, code: tree.code };
    const lines = [];
    for (const el of tree.elements) {
      if (el.isPassword) continue; // never echo secrets
      if (el.name && el.name.trim()) lines.push(el.name.trim());
    }
    return { ok: true, nodes: tree.count, text: lines.join('\n') };
  }

  /** Legacy control invoke by automationId — now path+RuntimeId verified. */
  async clickControl(title, automationId, opts = {}) {
    const exact = typeof title === 'object' && title && title.hwnd && title.pid;
    const res = exact ? { ok: true, window: title } : await this.resolveWindow(typeof title === 'object' ? title : { title }, opts);
    if (!res.ok) return { ok: false, error: res.error, code: res.code };
    const obs = await this.observe({ hwnd: res.window.hwnd }, { ...opts, screenshot: false });
    if (!obs.ok) return { ok: false, error: obs.error, code: obs.code };
    const el = obs.elements.find(e => e.automationId === String(automationId));
    if (!el) return { ok: false, error: 'control not found' };
    return this.invokeElement({ observationId: obs.observationId, elementRef: el.elementRef, sessionId: opts.sessionId || null }, opts);
  }

  /**
   * DEPRECATED raw-coordinate click. High risk, explicit permission scope
   * (computer.raw_coordinates), not part of the recommended schema.
   *
   * P3 Closure (C3.2): "deprecated" is NOT a security boundary. The raw path
   * may only fire when ALL of these hold:
   *   1. it belongs to a REAL, non-terminal Computer session
   *   2. the point is inside the LIVE rect of one of that session's
   *      authorized windows (HWND + PID re-validated at action time)
   *   3. that window is foreground at the moment of the click (atomic helper)
   * Anything else ⇒ executed = 0. Cross-window raw clicks are impossible.
   */
  async clickAt(x, y, opts = {}) {
    if (!coords.isFiniteNumber(x) || !coords.isFiniteNumber(y)) {
      return { ok: false, code: 'INVALID_COORDINATES', error: '坐标必须为有限数', executed: false };
    }
    // 1) raw coordinates require a real Computer session (fail closed)
    if (!this.sessions || !opts.sessionId) {
      return { ok: false, code: 'SESSION_REQUIRED', error: '裸坐标点击必须属于一个真实 Computer 会话', executed: false };
    }
    const session = this.sessions.get(opts.sessionId);
    if (!session) return { ok: false, code: 'SESSION_NOT_FOUND', error: 'Computer 会话不存在', executed: false };
    if (session.status !== 'ACTIVE') {
      const terminal = ['CANCELLED', 'COMPLETED', 'FAILED'].includes(session.status);
      return { ok: false, code: terminal ? 'SESSION_TERMINATED' : 'SESSION_NOT_ACTIVE', error: `会话未处于 ACTIVE（${session.status}）`, executed: false };
    }
    if (!session.allowedTargets.length) {
      return { ok: false, code: 'TARGET_NOT_ALLOWED', error: '该会话尚未绑定任何授权目标窗口，裸坐标点击被拒绝', executed: false };
    }
    // 2) the point must land inside the LIVE rect of an authorized target
    const px = Math.trunc(x), py = Math.trunc(y);
    for (const t of session.allowedTargets) {
      const probe = await winId.validateWindowRef(t, { sessionId: opts.sessionId, signal: opts.signal || null });
      if (!probe.ok) continue; // stale authorized entry — never auto-retarget
      if (!coords.withinBounds(px, py, probe.rect)) continue;
      const allowed = this.sessions.assertTargetAllowed(opts.sessionId, t);
      if (!allowed.ok) return { ...allowed, executed: false };
      const flags = opts.button === 'right' ? [8, 16] : [2, 4];
      // 3) atomic helper: IsWindow + PID + foreground fence right before mutation
      const script = `${PS_PRELUDE}
${NATIVE_CORE}
$h = New-Object IntPtr ${Math.trunc(Number(t.hwnd))};
if (-not [ADPC]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
${pidGuardPs('$h', t.pid)}
$fg = [ADPC]::GetForegroundWindow();
if ($fg -ne $h) { @{ok=$false; code="FOREGROUND_CHANGED"; executed=$false; foreground=$fg.ToInt64()} | ConvertTo-Json -Compress; exit }
$adpRect = New-Object ADPC+RECT;
if (-not [ADPC]::GetWindowRect($h, [ref]$adpRect)) { @{ok=$false; code="STALE_WINDOW"; executed=$false} | ConvertTo-Json -Compress; exit }
if (${px} -lt $adpRect.Left -or ${px} -ge $adpRect.Right -or ${py} -lt $adpRect.Top -or ${py} -ge $adpRect.Bottom) { @{ok=$false; code="COMPUTER_TARGET_BOUNDS_VIOLATION"; executed=$false} | ConvertTo-Json -Compress; exit }
[ADPC]::SetCursorPos(${px}, ${py}) | Out-Null;
[ADPC]::mouse_event(${flags[0]},0,0,0,[IntPtr]::Zero);
[ADPC]::mouse_event(${flags[1]},0,0,0,[IntPtr]::Zero);
@{ok=$true; executed=$true; deprecated=$true} | ConvertTo-Json -Compress`;
      const r = await runPs(script, { timeoutMs: 10000, sessionId: opts.sessionId, signal: opts.signal || null });
      if (!r.ok) return { ok: false, error: r.error, executed: false, code: r.cancelled ? 'CANCELLED' : (r.timedOut ? 'COMPUTER_TIMEOUT' : 'COMPUTER_ERROR') };
      const d = r.data || {};
      if (!d.executed) {
        this._reportProblem(d.code || 'FOREGROUND_CHANGED', '裸坐标点击前身份/前台校验失败', { sessionId: opts.sessionId });
        return { ok: false, code: d.code || 'FOREGROUND_CHANGED', error: '裸坐标点击被拒绝（窗口身份或前台已变化）', executed: false };
      }
      this.recordAction('click', { method: 'raw_deprecated', hwnd: t.hwnd, x: px, y: py }, true, null, { sessionId: opts.sessionId });
      return { ok: true, executed: true, deprecated: true, warning: 'computer_click_at 已弃用，请改用 computer_click_observed' };
    }
    return { ok: false, code: 'TARGET_NOT_ALLOWED', error: '坐标不在该会话任何已授权窗口的实时边界内，拒绝裸坐标点击', executed: false };
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Stop every helper and WAIT for confirmed exit. Registry shrinks only on
   * real termination; leftovers are reported as COMPUTER_RESIDUE truth.
   */
  async stopActive(opts = {}) {
    const before = psHost.activeCount();
    const r = await psHost.stopAll(opts.sessionId || null);
    const leftover = opts.sessionId ? psHost.activeCount(opts.sessionId) : psHost.activeCount();
    if (leftover > 0) this._reportProblem('COMPUTER_RESIDUE', `取消后仍有 ${leftover} 个 Computer 辅助进程存活`, {});
    this.recordAction('stop', { stopped: r.stopped, quiesced: r.quiesced, residual: leftover }, leftover === 0, leftover ? 'COMPUTER_RESIDUE' : null, {});
    return { ok: true, stopped: r.stopped, quiesced: r.quiesced, residual: leftover, activeBefore: before };
  }

  /**
   * P3 Closure (C1) — the ONE Computer session cancellation authority.
   *
   * ComputerManager.cancelSession() orchestrates the real resource teardown;
   * ComputerSessionRegistry.cancel() stays the canonical terminal transition
   * (status + hook lifecycle). There are no two competing cancel systems: a
   * session is only ever cancelled HERE, and only ever marked CANCELLED there.
   *
   * Before this returns, the cancelled session can produce NO further
   * mouse/keyboard/clipboard/UIA/vision mutation:
   *   observations invalidated → pending lock acquires rejected (they may
   *   NEVER inherit the lock later) → session helpers killed with CONFIRMED
   *   exit → clipboard transactions settled → canonical terminal transition.
   * The desktop lock itself frees via the in-flight action's finally after its
   * helper confirmed dead — never before quiescence.
   */
  async cancelSession(sessionId, { reason = '用户停止' } = {}) {
    const s = this.sessions ? this.sessions.get(sessionId) : null;
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND' };
    // 1) no stale observation ticket outlives the cancel
    this.observations.invalidateForSession(sessionId);
    // 2) queued (not yet granted) desktop-lock acquires reject NOW
    if (this.lock) this.lock.cancelPending(sessionId);
    // 3) stop this session's helpers and wait for CONFIRMED exit
    const stop = await this.stopActive({ sessionId });
    // 4) an in-flight clipboard transaction settles in its own finally once
    //    its helper settled — wait (bounded) for the counter to return to 0.
    for (let i = 0; i < 30 && this._clipboardTx > 0; i++) await new Promise(r => setTimeout(r, 100));
    // 5) canonical terminal transition + hooks (registry is the status truth)
    const reg = this.sessions ? await this.sessions.cancel(sessionId, { reason }) : { ok: true };
    const residual = psHost.activeCount(sessionId);
    const session = this.sessions ? this.sessions.get(sessionId) : s;
    const quiesced = stop.quiesced && residual === 0 && this._clipboardTx === 0;
    if (!quiesced) this._reportProblem('COMPUTER_RESIDUE', `会话取消后清理不完整（residual=${residual}, clipboardTx=${this._clipboardTx}）`, { sessionId });
    return {
      ok: !!(reg.ok && quiesced),
      session, status: session ? session.status : null,
      stop, residual, quiesced,
      clipboardTransactions: this._clipboardTx,
      lockHolderAfter: this.lock ? this.lock.holder() : null,
      lockPendingAfter: this.lock ? this.lock.pendingCount() : null,
      observationsAfter: this.observations.count()
    };
  }

  /**
   * P3 Closure (C10) — Run completed cleanly: settle the session into
   * COMPLETED (not CANCELLED) with the same residue invariants: observations
   * invalidated, pending lock acquires rejected, session helpers confirmed dead.
   */
  async completeSession(sessionId, { reason = 'Run 完成' } = {}) {
    const s = this.sessions ? this.sessions.get(sessionId) : null;
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND' };
    this.observations.invalidateForSession(sessionId);
    if (this.lock) this.lock.cancelPending(sessionId);
    const stop = await this.stopActive({ sessionId });
    const session = this.sessions ? this.sessions.complete(sessionId) : s;
    return { ok: stop.residual === 0, session, stop, residual: stop.residual };
  }

  async cancelForConversation(conversationId) {
    if (!this.sessions) return [];
    const list = this.sessions.forConversation(conversationId);
    const out = [];
    for (const s of list) out.push(await this.cancelSession(s.sessionId));
    return out;
  }

  /** Diagnostics snapshot (Health Center / Computer panel). */
  diagnostics() {
    return {
      activeHelpers: psHost.activeCount(),
      activeSessions: this.sessions ? this.sessions.activeCount() : 0,
      sessions: this.sessions ? this.sessions.summary() : [],
      desktopLock: this.lock ? this.lock.holder() : null,
      desktopLockPending: this.lock ? this.lock.pendingCount() : 0,
      observations: this.observations.count(),
      lastObservationAt: this.lastObservationAt,
      lastActionAt: this.lastActionAt,
      tempResidue: this.tempResidue(),
      clipboardTransactions: this._clipboardTx
    };
  }
}

/** Strip anything resembling input content from audit details. */
function sanitizeDetail(detail = {}) {
  const safe = {};
  const ALLOWED = ['hwnd', 'pid', 'process', 'title', 'method', 'x', 'y', 'captureMethod', 'keysLength', 'textLength', 'valueLength', 'sensitive', 'stopped', 'quiesced', 'residual'];
  for (const k of ALLOWED) if (detail[k] !== undefined) safe[k] = detail[k];
  return safe;
}

/* -------------------------------------------------------------------- tools */

const manager = new ComputerManager();

/**
 * Canonical Computer tool schema (P3). The model works with observations and
 * normalized coordinates; identity, fences and conversion stay server-side.
 */
function createComputerTools(runtime = {}) {
  const mgr = runtime.manager || manager;
  if (runtime.sessions) mgr.sessions = mgr.sessions || runtime.sessions;

  const defs = [
    { name: 'computer_list_windows', description: '列出当前打开的窗口（返回稳定身份 WindowRef：hwnd/pid/标题/进程/DPI）。后续操作请优先使用 hwnd。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: {} } },
    { name: 'computer_focus_window', description: '按标题或 hwnd 聚焦窗口（会真实验证前台）。同名窗口多个时会报 AMBIGUOUS_WINDOW，请改用 hwnd。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } } } },
    { name: 'computer_observe', description: '观察窗口：验证窗口身份 + 读取真实 UI 树 + 截图，返回 observationId（交互动作必须携带，几秒后过期）。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' }, screenshot: { type: 'boolean' } } } },
    { name: 'computer_click_observed', description: '基于观察的点击：normalizedX/normalizedY 为窗口内 0..1 归一化坐标，必须携带 observationId。越界/观察过期/前台被抢都会拒绝执行。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, normalized_x: { type: 'number' }, normalized_y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] } }, required: ['observation_id', 'normalized_x', 'normalized_y'] } },
    { name: 'computer_invoke_element', description: '调用（点击）观察树中的按钮/控件（UIA Invoke，比坐标点击可靠）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, element_ref: { type: 'string' } }, required: ['observation_id', 'element_ref'] } },
    { name: 'computer_set_element_value', description: '用 UIA ValuePattern 直接写入输入框。密码框需要额外显式授权，且永远不会回读内容。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, element_ref: { type: 'string' }, text: { type: 'string' } }, required: ['observation_id', 'element_ref', 'text'] } },
    { name: 'computer_toggle_element', description: '切换复选框/开关元素（UIA Toggle）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, element_ref: { type: 'string' } }, required: ['observation_id', 'element_ref'] } },
    { name: 'computer_select_element', description: '选中列表/组合框中的项（UIA SelectionItem）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, element_ref: { type: 'string' } }, required: ['observation_id', 'element_ref'] } },
    { name: 'computer_scroll_element', description: '滚动可滚动元素（UIA Scroll）。value>0 向下，<0 向上。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { observation_id: { type: 'string' }, element_ref: { type: 'string' }, value: { type: 'number' } }, required: ['observation_id', 'element_ref'] } },
    { name: 'computer_type_text', description: '向指定窗口输入文本（自动选择 UIA 写值 > 剪贴板粘贴 > 按键，剪贴板保证恢复）。必须指定目标窗口。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] } },
    { name: 'computer_press_keys', description: '向指定窗口发送按键（如 {TAB}、^v）。必须指定目标窗口，前台不符会拒绝发送。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' }, keys: { type: 'string' } }, required: ['keys'] } },
    { name: 'computer_screenshot', description: '截取整个虚拟桌面（含多显示器）并返回图片与坐标元数据。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: {} } },
    { name: 'computer_screenshot_window', description: '截取指定窗口（PrintWindow 优先），返回 captureMethod 元数据。最小化窗口会报 MINIMIZED_WINDOW_UNCAPTURABLE。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } } } },
    { name: 'computer_get_ui_tree', description: '获取窗口的真实 UI 控件树（有界：深度≤6、节点≤1000），元素带 elementRef。密码元素不会暴露值。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } }, required: [] } },
    { name: 'computer_get_window_text', description: '读取窗口内所有可见文本（UI 自动化）。密码框内容永远不会返回。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } } } },
    { name: 'computer_click_control', description: '按 automationId 调用窗口中的控件（走 observation + RuntimeId 校验）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, automation_id: { type: 'string' } }, required: ['title', 'automation_id'] } },
    { name: 'computer_set_control_value', description: '把文本写入窗口输入框（UIA 优先，需指定目标窗口）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, automation_id: { type: 'string' } }, required: ['title', 'text'] } },
    // DEPRECATED — high risk, explicit scope, absent from the recommended path.
    { name: 'computer_click_at', description: '【已弃用·高风险】裸屏幕坐标点击。需要额外授权（computer.raw_coordinates），请改用 computer_click_observed。', risk_level: 'high', permission: 'computer.raw_coordinates', deprecated: true, input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } }
  ];

  /**
   * P3 Closure (C2) — Session plumbing, FAIL CLOSED at the tool boundary.
   *
   * One ComputerSession per Run; rootRunId comes ONLY from the real
   * RunManager lineage. A Model/Renderer that self-reports runId/rootRunId/
   * parentRunId/sessionId gets nothing: unknown runId ⇒ SESSION_UNKNOWN_RUN
   * and the ENTIRE tool call is refused by the normalizer below — never
   * degraded into an unowned (sessionId=null) execution.
   *
   * This gate runs ONCE per tool call in the normalizer wrapper; execs read
   * the pre-computed result via sessionOf(ctx) so no tool can skip it.
   */
  function gateSession(ctx) {
    if (!mgr.sessions) return { ok: true, session: null };
    const runId = (ctx && ctx.runId) || null;
    if (!runId) {
      // panel / manual calls without a Run get an unowned pass (no target fence)
      return { ok: true, session: null };
    }
    // self-reported lineage fields are never trusted — only ctx.runId against
    // the RunManager decides identity.
    const r = mgr.sessions.create({
      runId,
      ownerAgentId: (ctx && ctx.agentId) || (ctx && ctx.agentName) || null,
      conversationId: (ctx && ctx.conversationId) || null
    });
    if (!r.ok) return r;
    if (r.session.status === 'CREATED') mgr.sessions.setStatus(r.session.sessionId, 'ACTIVE');
    return { ok: true, session: r.session };
  }

  /** Read the session the normalizer already gated (never re-derives). */
  function sessionOf(ctx) {
    return { ok: true, session: (ctx && ctx.__computerSession) || null };
  }

  /** Resolve + (first-time) authorize + bind target for a session. */
  async function bindTarget(ctx, session, q, opts) {
    const res = await mgr.resolveWindow(q, opts);
    if (!res.ok) return res;
    const ref = res.window;
    if (session) {
      let allowed = mgr.sessions.assertTargetAllowed(session.sessionId, ref);
      if (!allowed.ok && allowed.code === 'TARGET_NOT_ALLOWED') {
        // P3 Closure (C3.1): fresh authorization goes through the injected
        // user prompt; NO AUTHORIZER ⇒ DENY (fail closed, never default-allow).
        const reAuth = mgr.targetAuthorizer ? await mgr.targetAuthorizer({ sessionId: session.sessionId, windowRef: ref, ctx }) : false;
        if (reAuth) {
          mgr.sessions.allowTarget(session.sessionId, { hwnd: ref.hwnd, pid: ref.pid, title: ref.title });
          allowed = mgr.sessions.assertTargetAllowed(session.sessionId, ref);
        }
      }
      if (!allowed.ok) return allowed;
      mgr.sessions.bindTarget(session.sessionId, ref);
    }
    return { ok: true, window: ref };
  }

  const TERMINAL_SESSION = new Set(['CANCELLED', 'COMPLETED', 'FAILED']);

  /** Serialize mutations through the desktop lock (never interleave). */
  async function withLock(sessionId, reason, fn) {
    const sessionDenied = () => {
      if (sessionId && mgr.sessions) {
        const s = mgr.sessions.get(sessionId);
        if (!s || TERMINAL_SESSION.has(s.status)) {
          return { ok: false, code: 'SESSION_CANCELLED', error: '会话已终态，动作未执行' };
        }
      }
      return null;
    };
    if (!mgr.lock) {
      const denied = sessionDenied();
      if (denied) return denied;
      return fn();
    }
    let token = null;
    try {
      token = await mgr.lock.acquire({ sessionId, reason });
      // P3 Closure (C1): re-check the session RIGHT AFTER the grant — a cancel
      // that landed while this action was queued must win; a queued mutation
      // may never execute against a terminal session.
      const denied = sessionDenied();
      if (denied) return denied;
      return await fn();
    } catch (e) {
      if (e && e.code === 'LOCK_ACQUIRE_CANCELLED') return { ok: false, code: 'SESSION_CANCELLED', error: '会话已取消，动作未执行' };
      throw e;
    } finally {
      if (token) token.release();
    }
  }

  const execs = {
    computer_list_windows: async (ctx) => {
      const s = sessionOf(ctx);
      const r = await mgr.listWindows(15000, { sessionId: s.session ? s.session.sessionId : null });
      if (!r.ok) return { ok: false, error: { code: r.code || 'COMPUTER_ERROR', message: r.error } };
      return { ok: true, data: { windows: r.windows.map(w => ({ hwnd: w.hwnd, pid: w.pid, title: w.title, process: w.processName, rect: w.rect, dpi: w.dpi, minimized: w.minimized, foreground: w.foreground })) } };
    },
    computer_focus_window: async (ctx, a) => {
      const s = sessionOf(ctx);
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, { sessionId: s.session ? s.session.sessionId : null });
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'COMPUTER_ERROR', message: bound.error } };
      return withLock(s.session ? s.session.sessionId : null, 'focus', () => mgr.focusWindowRef(bound.window, { sessionId: s.session ? s.session.sessionId : null }));
    },
    computer_observe: async (ctx, a) => {
      const s = sessionOf(ctx);
      const q = a.hwnd ? { hwnd: a.hwnd } : { title: a.title };
      const bound = await bindTarget(ctx, s.session, q, {});
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'COMPUTER_ERROR', message: bound.error } };
      const r = await mgr.observe({ hwnd: bound.window.hwnd }, { sessionId: s.session ? s.session.sessionId : null, screenshot: a.screenshot !== false });
      if (!r.ok) return { ok: false, error: { code: r.code || 'COMPUTER_ERROR', message: r.error } };
      // observations are read-only: no desktop lock needed
      const elements = r.elements.filter(e => !e.offscreen).map(e => ({ element_ref: e.elementRef, name: e.name, automation_id: e.automationId, control_type: e.controlType, rect: e.boundingRect, is_password: e.isPassword, patterns: e.patterns }));
      return { ok: true, data: { observation_id: r.observationId, window: { hwnd: bound.window.hwnd, title: bound.window.title }, window_rect: r.windowRect, dpi: r.dpi, foreground: r.foreground, elements, element_count: elements.length, screenshot: r.screenshot } };
    },
    computer_click_observed: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'click', () => mgr.clickObserved({ observationId: a.observation_id, normalizedX: a.normalized_x, normalizedY: a.normalized_y, button: a.button || 'left', sessionId: sid }));
    },
    computer_invoke_element: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'invoke', () => mgr.invokeElement({ observationId: a.observation_id, elementRef: a.element_ref, sessionId: sid }));
    },
    computer_set_element_value: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'set_value', () => mgr.setElementValue({ observationId: a.observation_id, elementRef: a.element_ref, value: a.text, sessionId: sid }));
    },
    computer_toggle_element: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'toggle', () => mgr.toggleElement({ observationId: a.observation_id, elementRef: a.element_ref, sessionId: sid }));
    },
    computer_select_element: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'select', () => mgr.selectElement({ observationId: a.observation_id, elementRef: a.element_ref, sessionId: sid }));
    },
    computer_scroll_element: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'scroll', () => mgr.scrollElement({ observationId: a.observation_id, elementRef: a.element_ref, value: a.value || 1, sessionId: sid }));
    },
    computer_type_text: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, {});
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'NO_TARGET', message: bound.error || '输入必须指定目标窗口（title 或 hwnd）' } };
      return withLock(sid, 'type', () => mgr.typeTextToTarget({ target: bound.window, text: a.text, submit: !!a.submit, sessionId: sid }));
    },
    computer_press_keys: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, {});
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'NO_TARGET', message: bound.error || '按键必须指定目标窗口（title 或 hwnd）' } };
      return withLock(sid, 'keys', async () => {
        const focus = await mgr.focusWindowRef(bound.window, { sessionId: sid });
        if (!focus.ok) return focus;
        return mgr.pressKeys(a.keys, { foregroundHwnd: bound.window.hwnd, foregroundPid: bound.window.pid, sessionId: sid });
      });
    },
    computer_screenshot: async (ctx) => {
      const s = sessionOf(ctx);
      const r = await mgr.screenshot({ sessionId: s.session ? s.session.sessionId : null });
      if (!r.ok) return { ok: false, error: { code: 'COMPUTER_ERROR', message: r.error } };
      return { ok: true, data: r };
    },
    computer_screenshot_window: async (ctx, a) => {
      const s = sessionOf(ctx);
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, {});
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'COMPUTER_ERROR', message: bound.error } };
      const r = await mgr.screenshotWindowRef(bound.window, { sessionId: s.session ? s.session.sessionId : null });
      if (!r.ok) return { ok: false, error: { code: r.code || 'COMPUTER_ERROR', message: r.error } };
      return { ok: true, data: r };
    },
    computer_get_ui_tree: async (ctx, a) => {
      const s = sessionOf(ctx);
      const r = await mgr.getUiTree(a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, { sessionId: s.session ? s.session.sessionId : null });
      if (!r.ok) return { ok: false, error: { code: r.code || 'COMPUTER_ERROR', message: r.error } };
      return { ok: true, data: { nodes: r.nodes, truncated: r.truncated, tree: r.tree } };
    },
    computer_get_window_text: async (ctx, a) => {
      const s = sessionOf(ctx);
      const r = await mgr.getWindowText(a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, 400, { sessionId: s.session ? s.session.sessionId : null });
      if (!r.ok) return { ok: false, error: { code: r.code || 'COMPUTER_ERROR', message: r.error } };
      return { ok: true, data: { text: r.text, nodes: r.nodes } };
    },
    computer_click_control: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      // P3 Closure (C3): legacy automationId path goes through the SAME
      // resolve + target fence before any mutation.
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, { sessionId: sid });
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'COMPUTER_ERROR', message: bound.error } };
      return withLock(sid, 'click_control', () => mgr.clickControl(bound.window, a.automation_id, { sessionId: sid }));
    },
    computer_set_control_value: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      const bound = await bindTarget(ctx, s.session, a.hwnd ? { hwnd: a.hwnd } : { title: a.title }, { sessionId: sid });
      if (!bound.ok) return { ok: false, error: { code: bound.code || 'COMPUTER_ERROR', message: bound.error } };
      return withLock(sid, 'set_control_value', () => mgr.setControlValue(bound.window.title, a.text, { hwnd: bound.window.hwnd, pid: bound.window.pid, processName: bound.window.processName, automationId: a.automation_id || '', sessionId: sid }));
    },
    computer_click_at: async (ctx, a) => {
      const s = sessionOf(ctx);
      const sid = s.session ? s.session.sessionId : null;
      return withLock(sid, 'raw_click', () => mgr.clickAt(a.x, a.y, { sessionId: sid }));
    }
  };

  // Normalize every exec to the runtime contract { ok, data } | { ok:false, error }
  const normalized = {};
  for (const [name, fn] of Object.entries(execs)) {
    normalized[name] = async (ctx, a) => {
      try {
        // P3 Closure (C2) — the ONE session gate for every Computer tool.
        // A failed session (e.g. SESSION_UNKNOWN_RUN from a fake/self-reported
        // runId) refuses the WHOLE call here: OS mutation exec = 0, helper
        // spawn = 0, lock acquire = 0, target authorize = 0.
        const gate = gateSession(ctx);
        if (!gate.ok) {
          return { ok: false, error: { code: gate.code || 'SESSION_DENIED', message: gate.error || 'Computer 会话创建失败（fail closed）' } };
        }
        const callCtx = { ...(ctx || {}), __computerSession: gate.session || null };
        const r = await fn(callCtx, a || {});
        if (!r || r.ok === false) {
          const err = (r && r.error) || {};
          const code = (typeof err === 'object' && err.code) || r.code || 'COMPUTER_ERROR';
          const message = (typeof err === 'object' && err.message) || (typeof err === 'string' ? err : (r && r.error) || '操作失败');
          return { ok: false, error: { code, message } };
        }
        const { ok, ...rest } = (r && typeof r === 'object') ? r : { value: r };
        return { ok: true, data: rest.data !== undefined ? rest.data : rest };
      } catch (e) {
        return { ok: false, error: { code: 'COMPUTER_ERROR', message: e.message } };
      }
    };
  }

  return { defs, execs: normalized, manager: mgr };
}

module.exports = { ComputerManager, createComputerTools, manager, escapeSendKeys, psLiteral, ps, sanitizeDetail };
