# P3 Computer Use Hardening — TEST-ONLY Windows fixture (never shipped).
#
# WPF (not WinForms): PowerShell-hosted WinForms only exposes the legacy HWND
# proxy (everything reads as Pane with numeric ids, no patterns), while WPF is
# built directly on UIA — real ControlTypes, AutomationIds, Invoke/Value/
# Toggle/SelectionItem/Scroll patterns and IsPassword for the PasswordBox.
#
# Controls (AutomationId in parentheses):
#   textInput      TextBox        TextChanged -> status = "TEXT:<length>"
#   passwordInput  PasswordBox    IsPassword=true, value never echoed
#   actionButton   Button         Click       -> status = "CLICKED"
#   checkbox1      CheckBox       TogglePattern
#   combo1         ComboBox       Alpha/Beta/Gamma (SelectionItem children)
#   scrollPanel    ScrollViewer   ScrollPattern, tall content
#   mutateButton   adds/removes dynamicLabel (control-tree change -> STALE_ELEMENT)
#   statusLabel    machine-readable status line
param(
  [string]$Title = 'ADP P3 Fixture',
  [int]$X = 120,
  [int]$Y = 120
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

function Set-AutomationId($el, [string]$id) {
  $el.SetValue([System.Windows.Automation.AutomationProperties]::AutomationIdProperty, $id)
}

$win = New-Object System.Windows.Window
$win.Title = $Title
$win.Width = 600; $win.Height = 480
$win.WindowStartupLocation = 'Manual'
$win.Left = $X; $win.Top = $Y

$grid = New-Object System.Windows.Controls.StackPanel
$grid.Margin = New-Object System.Windows.Thickness(12)
$win.Content = $grid

# ---- status (top, machine readable) ----
$statusLabel = New-Object System.Windows.Controls.TextBlock
$statusLabel.Text = 'READY'
$statusLabel.FontSize = 16
$statusLabel.FontWeight = 'Bold'
Set-AutomationId $statusLabel 'statusLabel'
$grid.Children.Add($statusLabel) | Out-Null

# ---- text input ----
$textInput = New-Object System.Windows.Controls.TextBox
$textInput.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
Set-AutomationId $textInput 'textInput'
$grid.Children.Add($textInput) | Out-Null

# ---- password input (IsPassword = true, never echoed) ----
$passwordInput = New-Object System.Windows.Controls.PasswordBox
$passwordInput.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
Set-AutomationId $passwordInput 'passwordInput'
$grid.Children.Add($passwordInput) | Out-Null

# ---- action row: button + checkbox + combo ----
$row = New-Object System.Windows.Controls.StackPanel
$row.Orientation = 'Horizontal'
$row.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
$grid.Children.Add($row) | Out-Null

$actionButton = New-Object System.Windows.Controls.Button
$actionButton.Content = 'Do It'
$actionButton.Width = 120
Set-AutomationId $actionButton 'actionButton'
$row.Children.Add($actionButton) | Out-Null

$checkbox1 = New-Object System.Windows.Controls.CheckBox
$checkbox1.Content = 'Option'
$checkbox1.VerticalAlignment = 'Center'
$checkbox1.Margin = New-Object System.Windows.Thickness(12, 0, 0, 0)
Set-AutomationId $checkbox1 'checkbox1'
$row.Children.Add($checkbox1) | Out-Null

$combo1 = New-Object System.Windows.Controls.ComboBox
$combo1.Width = 140
$combo1.Margin = New-Object System.Windows.Thickness(12, 0, 0, 0)
foreach ($item in @('Alpha', 'Beta', 'Gamma')) {
  $ci = New-Object System.Windows.Controls.ComboBoxItem
  $ci.Content = $item
  $combo1.Items.Add($ci) | Out-Null
}
$combo1.SelectedIndex = 0
Set-AutomationId $combo1 'combo1'
$row.Children.Add($combo1) | Out-Null

# ---- scrollable panel ----
$scrollPanel = New-Object System.Windows.Controls.ScrollViewer
$scrollPanel.Height = 130
$scrollPanel.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
Set-AutomationId $scrollPanel 'scrollPanel'
$scrollContent = New-Object System.Windows.Controls.TextBlock
$scrollContent.Text = 'SCROLL ' + ('line ' * 160)
$scrollContent.TextWrapping = 'Wrap'
$scrollContent.Width = 540    # bounded width => wrapped lines
$scrollContent.Height = 900   # explicit height GUARANTEES vertical overflow
$scrollPanel.Content = $scrollContent
$grid.Children.Add($scrollPanel) | Out-Null

# ---- mutate button (adds/removes dynamicLabel => STALE_ELEMENT proofs) ----
$mutateButton = New-Object System.Windows.Controls.Button
$mutateButton.Content = 'Mutate Tree'
$mutateButton.Width = 120
$mutateButton.HorizontalAlignment = 'Left'
$mutateButton.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
Set-AutomationId $mutateButton 'mutateButton'
$grid.Children.Add($mutateButton) | Out-Null

# ---- behaviour ----
$actionButton.Add_Click({ $statusLabel.Text = 'CLICKED' })
$textInput.Add_TextChanged({ $statusLabel.Text = 'TEXT:' + $textInput.Text.Length })
# the password box intentionally NEVER writes its content to the status label

$script:dynamicLabel = $null
$mutateButton.Add_Click({
  if ($null -eq $script:dynamicLabel) {
    $script:dynamicLabel = New-Object System.Windows.Controls.TextBlock
    $script:dynamicLabel.Text = 'DYNAMIC_PRESENT'
    Set-AutomationId $script:dynamicLabel 'dynamicLabel'
    $grid.Children.Add($script:dynamicLabel) | Out-Null
  } else {
    $grid.Children.Remove($script:dynamicLabel) | Out-Null
    $script:dynamicLabel = $null
  }
})

# ShowDialog blocks until the process is killed by the test harness.
$win.ShowDialog() | Out-Null
