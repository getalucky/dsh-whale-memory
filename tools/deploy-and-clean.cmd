@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo [1/2] 清理碎记忆（归档，可回滚）
node tools\cleanup-fragments.mjs
if errorlevel 1 goto fail

echo.
echo [2/2] 打包并部署当前版本
node tools\deploy.mjs
if errorlevel 1 goto fail

echo.
echo 全部完成。现在可以打开 DSH。
echo 打开后看总览页：版本号跟 package.json 里一致就对。
goto end

:fail
echo.
echo 上面有报错，先别打开 DSH。把窗口里的内容拍下来。

:end
echo.
pause
