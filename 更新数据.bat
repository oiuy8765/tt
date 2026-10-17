@echo off
chcp 65001 >nul
echo ========================================
echo   更新数据（重新抓取 + 重算 + 构建静态站）
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 重新抓取全站榜单与详情（约 2 分钟）...
call node _enrich_all.js
if errorlevel 1 (
  echo 抓取失败，已停止。
  pause
  exit /b 1
)

echo.
echo [2/2] 构建静态站点...
call node build-static.js

echo.
echo 数据已更新到 dist\ 目录。
echo 双击「一键部署到Cloudflare.bat」即可发布上线。
pause
