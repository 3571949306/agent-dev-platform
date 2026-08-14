'use strict';
/**
 * P3 Computer Use Hardening — stable window identity (WindowRef).
 *
 * v2.9.9 located windows with `MainWindowTitle -like "*title*" | Select-Object
 * -First 1` — two Notepads meant the Agent operated on whichever came first,
 * and a recycled HWND silently retargeted a brand-new window. Production
 * identity is (HWND + PID) discovered once, then re-verified before every
 * action:
 *
 *   discovery  → computer_list_windows / resolveWindow → WindowRef
 *   action     → hwnd (+ pid guard); title is only ever a DISCOVERY input
 *   ambiguity  → AMBIGUOUS_WINDOW (never pick one silently)
 *   closed/recycled HWND → STALE_WINDOW (never auto-switch to same title)
 */
const { runPs, psLiteral, PS_PRELUDE } = require('./psHost');

const ENUM_WINDOWS_PS = `Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
using System.Text;
public static class ADPEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // The enumeration callback lives INSIDE C#: marshalling a PowerShell
  // scriptblock as an EnumWindows delegate corrupts memory (AccessViolation).
  private static EnumWindowsProc _cb;
  public static List<IntPtr> VisibleHwnds() {
    var list = new List<IntPtr>();
    _cb = delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) list.Add(h); return true; };
    EnumWindows(_cb, IntPtr.Zero);
    return list;
  }
}
"@
${PS_PRELUDE}
$hwnds = [ADPEnum]::VisibleHwnds();
$fg = [ADPEnum]::GetForegroundWindow();
$results = New-Object System.Collections.Generic.List[object];
foreach ($h in $hwnds) {
  $sb = New-Object System.Text.StringBuilder 512;
  [ADPEnum]::GetWindowText($h, $sb, 512) | Out-Null;
  $title = $sb.ToString();
  if (-not $title) { continue }
  $pidw = [uint32]0; [ADPEnum]::GetWindowThreadProcessId($h, [ref]$pidw) | Out-Null;
  $pname = ''; $ppath = '';
  try { $pr = [System.Diagnostics.Process]::GetProcessById([int]$pidw); $pname = $pr.ProcessName; try { $ppath = $pr.MainModule.FileName } catch { } } catch { }
  $r = New-Object ADPEnum+RECT; [ADPEnum]::GetWindowRect($h, [ref]$r) | Out-Null;
  $dpi = 0; try { $dpi = [ADPEnum]::GetDpiForWindow($h) } catch { $dpi = 96 }
  $mon = [ADPEnum]::MonitorFromWindow($h, 2).ToInt64();
  $min = [ADPEnum]::IsIconic($h);
  $results.Add(@{hwnd=$h.ToInt64(); pid=[int]$pidw; processName=$pname; processPath=$ppath; title=$title;
    x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top);
    monitorId=$mon; dpi=$dpi; minimized=$min; foreground=($h -eq $fg)});
}
@{ok=$true; windows=$results} | ConvertTo-Json -Compress -Depth 4`;

/** Enumerate visible top-level windows with stable identity. */
async function listWindowRefs({ timeoutMs = 15000, sessionId = null, signal = null } = {}) {
  if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED', error: 'computer 仅支持 Windows' };
  const r = await runPs(ENUM_WINDOWS_PS, { timeoutMs, sessionId, signal });
  if (!r.ok) return { ok: false, error: r.error };
  const data = r.data || {};
  if (data.ok === false) return { ok: false, error: data.error || '枚举窗口失败' };
  const raw = Array.isArray(data.windows) ? data.windows : (data.windows ? [data.windows] : []);
  // ConvertTo-Json collapses single-item arrays; also normalise empty objects.
  const windows = raw
    .filter(w => w && (w.hwnd || w.title))
    .map(w => ({
      hwnd: Number(w.hwnd) || 0,
      pid: Number(w.pid) || 0,
      processName: String(w.processName || ''),
      processPath: String(w.processPath || ''),
      title: String(w.title || ''),
      rect: { x: Number(w.x) || 0, y: Number(w.y) || 0, width: Number(w.width) || 0, height: Number(w.height) || 0 },
      monitorId: String(w.monitorId != null ? w.monitorId : ''),
      dpi: Number(w.dpi) || 96,
      dpiScale: (Number(w.dpi) || 96) / 96,
      visible: true,
      minimized: !!w.minimized,
      foreground: !!w.foreground,
      // legacy fields for desktopBridge compatibility
      process: String(w.processName || ''), focused: !!w.foreground
    }));
  return { ok: true, windows };
}

/**
 * Resolve exactly ONE WindowRef from discovery input.
 *   hwnd → exact match (then staleness guard by pid)
 *   title → exact title first, then substring; 0 → WINDOW_NOT_FOUND,
 *           >1 → AMBIGUOUS_WINDOW (Select-Object -First 1 is forbidden)
 */
function resolveFromList(windows, { hwnd = null, title = null, pid = null } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  if (hwnd) {
    const w = list.find(x => Number(x.hwnd) === Number(hwnd));
    if (!w) return { ok: false, code: 'STALE_WINDOW', error: '窗口已关闭或句柄已失效' };
    if (pid && Number(w.pid) !== Number(pid)) return { ok: false, code: 'STALE_WINDOW', error: '窗口进程已变化（HWND 被复用）' };
    return { ok: true, window: w };
  }
  let candidates = list;
  if (pid) candidates = candidates.filter(w => Number(w.pid) === Number(pid));
  if (title) {
    const exact = candidates.filter(w => w.title === title);
    if (exact.length === 1) return { ok: true, window: exact[0] };
    if (exact.length > 1) return { ok: false, code: 'AMBIGUOUS_WINDOW', candidates: exact.length, error: `存在 ${exact.length} 个同名窗口，请用 hwnd 指定` };
    const sub = candidates.filter(w => w.title.toLowerCase().includes(String(title).toLowerCase()));
    if (sub.length === 1) return { ok: true, window: sub[0] };
    if (sub.length > 1) return { ok: false, code: 'AMBIGUOUS_WINDOW', candidates: sub.length, error: `存在 ${sub.length} 个标题匹配的窗口，请用 hwnd 指定` };
    return { ok: false, code: 'WINDOW_NOT_FOUND', error: `未找到窗口「${title}」` };
  }
  if (candidates.length === 1) return { ok: true, window: candidates[0] };
  if (candidates.length > 1) return { ok: false, code: 'AMBIGUOUS_WINDOW', candidates: candidates.length, error: '未指定窗口身份' };
  return { ok: false, code: 'WINDOW_NOT_FOUND', error: '未找到窗口' };
}

const VALIDATE_PS = (hwnd, pid) => `${PS_PRELUDE}
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPValidate {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = New-Object IntPtr ${Math.trunc(Number(hwnd))};
if (-not [ADPValidate]::IsWindow($h)) { @{ok=$false; code="STALE_WINDOW"; reason="hwnd-invalid"} | ConvertTo-Json -Compress; exit }
$now = [uint32]0; [ADPValidate]::GetWindowThreadProcessId($h, [ref]$now) | Out-Null;
if ($now -ne ${Math.trunc(Number(pid))}) { @{ok=$false; code="STALE_WINDOW"; reason="pid-changed"; currentPid=[int]$now} | ConvertTo-Json -Compress; exit }
$r = New-Object ADPValidate+RECT; [ADPValidate]::GetWindowRect($h, [ref]$r) | Out-Null;
$fg = [ADPValidate]::GetForegroundWindow();
@{ok=$true; x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top); foreground=($fg -eq $h)} | ConvertTo-Json -Compress`;

/**
 * Re-verify a WindowRef against the live desktop before trusting it:
 * IsWindow + PID unchanged → fresh rect/foreground. Failure = STALE_WINDOW —
 * the caller must re-discover; silently retargeting a same-title window is
 * exactly what this fence forbids.
 */
async function validateWindowRef(ref, { timeoutMs = 10000, sessionId = null, signal = null } = {}) {
  if (!ref || !ref.hwnd || !ref.pid) return { ok: false, code: 'STALE_WINDOW', error: '缺少窗口身份（hwnd/pid）' };
  if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED', error: 'computer 仅支持 Windows' };
  const r = await runPs(VALIDATE_PS(ref.hwnd, ref.pid), { timeoutMs, sessionId, signal });
  if (!r.ok) return { ok: false, code: 'COMPUTER_TIMEOUT', error: r.error };
  const d = r.data || {};
  if (d.ok === false) return { ok: false, code: d.code || 'STALE_WINDOW', reason: d.reason, error: '窗口身份校验失败' };
  return {
    ok: true,
    rect: { x: Number(d.x) || 0, y: Number(d.y) || 0, width: Number(d.width) || 0, height: Number(d.height) || 0 },
    foreground: !!d.foreground
  };
}

/** Current foreground HWND (0 when none) — the fence truth source. */
const FOREGROUND_PS = `${PS_PRELUDE}
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
@{ok=$true; hwnd=[ADPFg]::GetForegroundWindow().ToInt64()} | ConvertTo-Json -Compress`;

async function getForegroundHwnd({ timeoutMs = 8000, sessionId = null, signal = null } = {}) {
  if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED', hwnd: 0 };
  const r = await runPs(FOREGROUND_PS, { timeoutMs, sessionId, signal });
  if (!r.ok) return { ok: false, error: r.error, hwnd: 0 };
  return { ok: true, hwnd: Number((r.data || {}).hwnd) || 0 };
}

module.exports = { listWindowRefs, resolveFromList, validateWindowRef, getForegroundHwnd };
