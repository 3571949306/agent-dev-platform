'use strict';
/**
 * Windows Computer runtime — local GUI control via PowerShell + .NET UIAutomation.
 * No native node module required (reliable to package). All ops are best-effort
 * and never crash the host app.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ps(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const trimmed = out.trim();
      const line = trimmed.split('\n').filter(l => l.trim().startsWith('{')).pop();
      try { resolve({ ok: true, data: line ? JSON.parse(line) : trimmed }); }
      catch { resolve({ ok: false, error: (err || trimmed || 'no output').slice(0, 300) }); }
    });
  });
}

class ComputerManager {
  async listWindows() {
    const r = await ps(`Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{pid=$_.Id; title=$_.MainWindowTitle} } | ConvertTo-Json -Compress`);
    if (!r.ok) return { ok: false, error: r.error };
    let arr = r.data; if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];
    return { ok: true, windows: arr };
  }
  async focusWindow(title) {
    const t = (title || '').replace(/'/g, "''");
    const r = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class U { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t); }
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${t}*" } | Select-Object -First 1
if ($p) { [U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; @{ok=$true; pid=$p.Id} | ConvertTo-Json -Compress } else { @{ok=$false; error="未找到窗口: ${t}"} | ConvertTo-Json -Compress }`);
    return r.ok ? r.data : { ok: false, error: r.error };
  }
  async screenshot() {
    const file = path.join(os.tmpdir(), 'adp_shot_' + Date.now() + '.png');
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
$bmp.Save('${file.replace(/'/g, "''")}');
$g.Dispose(); $bmp.Dispose();
@{ok=$true; path='${file.replace(/'/g, "''")}'} | ConvertTo-Json -Compress`);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      const b64 = fs.readFileSync(file).toString('base64');
      fs.unlinkSync(file);
      return { ok: true, data_url: 'data:image/png;base64,' + b64 };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  async pressKeys(keys) {
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${String(keys).replace(/'/g, "''")}') ; @{ok=$true} | ConvertTo-Json -Compress`);
    return r.ok ? r.data : { ok: false, error: r.error };
  }
  async clickAt(x, y) {
    const r = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); }
"@
[M]::SetCursorPos(${x},${y});
[M]::mouse_event(2,0,0,0,0);
[M]::mouse_event(4,0,0,0,0);
@{ok=$true} | ConvertTo-Json -Compress`);
    return r.ok ? r.data : { ok: false, error: r.error };
  }
  async getUiTree(title) {
    const t = (title || '').replace(/'/g, "''");
    const script = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$ae = [System.Windows.Automation.AutomationElement];
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${t}*" } | Select-Object -First 1;
if (-not $p) { @{ok=$false; error="no window"} | ConvertTo-Json -Compress; exit }
$h = $p.MainWindowHandle;
$root = $ae::FromHandle($h);
function Walk($e, $d) {
  if ($d -gt 3) { return $null }
  $name = $e.Current.Name; $ct = $e.Current.ControlType.ProgrammaticName;
  $children = @();
  try { $c = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::True) } catch { $c = $null }
  if ($c) { $i=0; foreach ($ch in $c) { if ($i++ -gt 40) { break }; $children += @{name=$ch.Current.Name; type=$ch.Current.ControlType.ProgrammaticName; automationId=$ch.Current.AutomationId } } }
  @{name=$name; type=$ct; children=$children} | ConvertTo-Json -Compress -Depth 4
}
Walk $root 0`;
    const r = await ps(script);
    return r.ok ? r.data : { ok: false, error: r.error };
  }
  async clickControl(title, automationId) {
    const t = (title || '').replace(/'/g, "''");
    const aid = (automationId || '').replace(/'/g, "''");
    const script = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$ae = [System.Windows.Automation.AutomationElement];
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${t}*" } | Select-Object -First 1;
if (-not $p) { @{ok=$false; error="no window"} | ConvertTo-Json -Compress; exit }
$root = $ae::FromHandle($p.MainWindowHandle);
$cond = New-Object System.Windows.Automation.PropertyCondition($ae::AutomationIdProperty, '${aid}');
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond);
if (-not $el) { @{ok=$false; error="control not found"} | ConvertTo-Json -Compress; exit }
$invoke = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
if ($invoke) { $invoke.Invoke(); @{ok=$true} | ConvertTo-Json -Compress } else { @{ok=$false; error="not invokable"} | ConvertTo-Json -Compress }`;
    const r = await ps(script);
    return r.ok ? r.data : { ok: false, error: r.error };
  }
}

const manager = new ComputerManager();

function createComputerTools() {
  const defs = [
    { name: 'computer_list_windows', description: '列出当前打开的窗口（标题与进程号）。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: {} } },
    { name: 'computer_focus_window', description: '按标题聚焦某个窗口。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'computer_screenshot', description: '截取屏幕并返回图片（base64）。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: {} } },
    { name: 'computer_press_keys', description: '向当前焦点窗口发送按键（如 %{TAB} 或 hello）。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
    { name: 'computer_click_at', description: '在屏幕坐标 (x,y) 点击。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
    { name: 'computer_get_ui_tree', description: '获取窗口的 UI 自动化控件树。', risk_level: 'low', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'computer_click_control', description: '按 automationId 调用窗口中的控件。', risk_level: 'medium', permission: 'computer', input_schema: { type: 'object', properties: { title: { type: 'string' }, automation_id: { type: 'string' } }, required: ['title', 'automation_id'] } }
  ];
  const raw = {
    computer_list_windows: async () => manager.listWindows(),
    computer_focus_window: async (c, a) => manager.focusWindow(a.title),
    computer_screenshot: async () => manager.screenshot(),
    computer_press_keys: async (c, a) => manager.pressKeys(a.keys),
    computer_click_at: async (c, a) => manager.clickAt(a.x, a.y),
    computer_get_ui_tree: async (c, a) => manager.getUiTree(a.title),
    computer_click_control: async (c, a) => manager.clickControl(a.title, a.automation_id)
  };
  // Normalize to the runtime tool contract: { ok, data } | { ok:false, error }
  const execs = {};
  for (const [name, fn] of Object.entries(raw)) {
    execs[name] = async (ctx, a) => {
      try {
        const r = await fn(ctx, a || {});
        if (r && r.ok === false) return { ok: false, error: r.error || { code: 'COMPUTER_ERROR', message: '操作失败' } };
        const { ok, ...rest } = (r && typeof r === 'object') ? r : { value: r };
        return { ok: true, data: rest };
      } catch (e) { return { ok: false, error: { code: 'COMPUTER_ERROR', message: e.message } }; }
    };
  }
  return { defs, execs, manager };
}

module.exports = { ComputerManager, createComputerTools, manager };
