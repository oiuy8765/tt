Add-Type -AssemblyName System.Drawing

$W = 1200
$H = 630
$bmp = [System.Drawing.Bitmap]::new($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$p0 = [System.Drawing.Point]::new(0, 0)
$p1 = [System.Drawing.Point]::new($W, $H)
$c1 = [System.Drawing.Color]::FromArgb(255, 12, 13, 28)
$c2 = [System.Drawing.Color]::FromArgb(255, 38, 28, 108)
$bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p0, $p1, $c1, $c2)
$g.FillRectangle($bg, 0, 0, $W, $H)

$glow1 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 122, 92, 246))
$g.FillEllipse($glow1, 760, -180, 720, 720)
$glow2 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(26, 81, 69, 229))
$g.FillEllipse($glow2, 900, 300, 560, 560)

$bp0 = [System.Drawing.Point]::new(72, 66)
$bp1 = [System.Drawing.Point]::new(124, 118)
$bgr = [System.Drawing.Drawing2D.LinearGradientBrush]::new($bp0, $bp1, [System.Drawing.Color]::FromArgb(255,81,69,229), [System.Drawing.Color]::FromArgb(255,146,110,255))
$g.FillRectangle($bgr, 72, 66, 52, 52)

$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 4)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pts = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(82, 102),
  [System.Drawing.PointF]::new(93, 91),
  [System.Drawing.PointF]::new(103, 98),
  [System.Drawing.PointF]::new(114, 80)
)
$g.DrawLines($pen, $pts)

$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$sub = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 178, 176, 216))

$fBrand = [System.Drawing.Font]::new("Segoe UI", 30, [System.Drawing.FontStyle]::Bold)
$g.DrawString("TrendSift", $fBrand, $white, 144, 72)

$fH1 = [System.Drawing.Font]::new("Segoe UI", 58, [System.Drawing.FontStyle]::Bold)
$g.DrawString("What's rising,", $fH1, $white, 68, 205)
$g.DrawString("and still early enough.", $fH1, $white, 68, 285)

$fSub = [System.Drawing.Font]::new("Segoe UI", 25, [System.Drawing.FontStyle]::Regular)
$g.DrawString("Google Trends rising searches  |  4,800+ topics  |  5 languages", $fSub, $sub, 72, 398)

$linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(46, 255, 255, 255), 1)
$g.DrawLine($linePen, 72, 498, 1128, 498)

$fTag = [System.Drawing.Font]::new("Segoe UI", 21, [System.Drawing.FontStyle]::Regular)
$g.DrawString("90d / 12m growth  |  seasonality  |  rising related queries", $fTag, $sub, 72, 526)
$g.DrawString("trendsift.site", $fTag, $white, 930, 526)

$out = "D:\google-trends-rising\public\og.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("saved " + $out + " " + (Get-Item $out).Length + " bytes")
