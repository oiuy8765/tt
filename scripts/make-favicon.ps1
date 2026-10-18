Add-Type -AssemblyName System.Drawing

function Make-Icon([int]$size, [string]$out) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $r = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
  $p0 = [System.Drawing.Point]::new(0, 0)
  $p1 = [System.Drawing.Point]::new($size, $size)
  $bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p0, $p1, [System.Drawing.Color]::FromArgb(255,81,69,229), [System.Drawing.Color]::FromArgb(255,124,92,246))
  $g.FillRectangle($bg, $r)

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [Math]::Max(2, $size / 10))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pad = $size * 0.22
  $pts = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(($pad), ($size * 0.62)),
    [System.Drawing.PointF]::new(($size * 0.42), ($size * 0.46)),
    [System.Drawing.PointF]::new(($size * 0.58), ($size * 0.54)),
    [System.Drawing.PointF]::new(($size - $pad), ($size * 0.28))
  )
  $g.DrawLines($pen, $pts)

  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

Make-Icon 32 "D:\google-trends-rising\.tmp-ico\icon32.png"
Make-Icon 16 "D:\google-trends-rising\.tmp-ico\icon16.png"
Write-Output "ok"
