@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================
echo   TrendSift - 构建并部署到 Cloudflare Pages
echo ========================================
echo.

rem Cloudflare API 在国内直连更稳，清掉可能存在的代理环境变量
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "ALL_PROXY="
set "all_proxy="

rem ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js。请先安装 Node.js 18 以上版本：https://nodejs.org
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo Node.js 版本：%%v
echo 工作目录：%CD%
echo.

rem ---------- 1/2 构建 ----------
echo [1/2] 构建静态站点（5 种语言）...
call node build-static.js
if errorlevel 1 (
  echo.
  echo [错误] 构建失败，已停止部署。请看上面第一条报错。
  goto :fail
)
if not exist "dist\index.html" (
  echo [错误] 构建结束但没有生成 dist\index.html。
  goto :fail
)
echo.
echo 构建完成，产物目录：%CD%\dist
echo.

rem ---------- 2/2 部署 ----------
echo [2/2] 部署到 Cloudflare Pages（项目名 trends-radar）...
call npx --yes wrangler pages deploy dist --project-name=trends-radar --commit-dirty=true
if errorlevel 1 (
  echo.
  echo [错误] 部署失败。常见原因与处理：
  echo   1. 未登录 / 授权过期：先在命令行执行  npx wrangler login  再重跑本脚本
  echo   2. 想免登录部署：设置环境变量 CLOUDFLARE_API_TOKEN（Cloudflare 后台创建 API 令牌）
  echo   3. 网络问题：确认能访问 api.cloudflare.com
  goto :fail
)

echo.
echo ========================================
echo   部署完成
echo   正式域名  https://trendsift.site
echo   语言版本  /（简体）  /zh-tw/  /en/  /ja/  /ko/
echo ========================================
pause
exit /b 0

:fail
echo.
pause
exit /b 1
