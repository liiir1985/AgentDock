@echo off
setlocal EnableDelayedExpansion
rem ==============================================================
rem  AgentDock 阶段 1 —— 一键试用启动器
rem    agentdock-try.bat            沙箱试用【%TEMP%\agentdock-trial，带 git 基线，最安全】
rem    agentdock-try.bat 目录       用你自己的项目【真的会改文件，需输入 y 确认】
rem    agentdock-try.bat /check     只做预检 + 编译 + 准备沙箱，打印启动命令，不启动
rem    agentdock-try.bat /force     跳过“VS Code 正在运行”的检查
rem  可选环境变量：
rem    AGENTDOCK_NO_PAUSE=1         结束时不等按键
rem    VSCODE_EXECUTABLE=<Code.exe> 指定 VS Code 可执行文件
rem    ISOLATE=0                    不传 --disable-extensions【默认 1，屏蔽其他扩展以免干扰】
rem ==============================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "EXTDIR=%REPO%\packages\vscode"
set "FIXTURE=%REPO%\packages\vscode\test\fixtures\workspace"
set "MODE=launch"
if not defined ISOLATE set "ISOLATE=1"
set "TARGET=%~1"

if /I "%~1"=="/?" goto :usage
if /I "%~1"=="/help" goto :usage
if /I "%~1"=="/check" set "MODE=check"
if /I "%~1"=="/check" set "TARGET="
if /I "%~1"=="/force" set "FORCE=1"
if /I "%~1"=="/force" set "TARGET="

echo === AgentDock 试用启动器 ===
echo 仓库：%REPO%

echo.
echo [1/5] 定位 VS Code
call :find_code
if not defined CODE goto :fail

if defined FORCE goto :skip_running_check
echo.
echo [2/5] 确认没有已运行的 VS Code
call :check_running
if errorlevel 1 goto :fail
goto :compile_step

:skip_running_check
echo.
echo [2/5] 已用 /force 跳过运行状态检查

:compile_step
echo.
echo [3/5] 编译 TypeScript
where npm >nul 2>nul
if errorlevel 1 (
	echo   【警告】PATH 里没有 npm —— 需要 Node.js 22+ 才能编译
	goto :fail
)
pushd "%REPO%"
call npm run compile
if errorlevel 1 (
	popd
	echo   【警告】npm run compile 失败，先修编译错误
	goto :fail
)
popd
if not exist "%EXTDIR%\out\extension.js" (
	echo   【警告】编译产物缺失：%EXTDIR%\out\extension.js
	goto :fail
)
echo       OK

echo.
echo [4/5] 准备目标工作区
if not defined TARGET call :prep_sandbox
if not defined TARGET goto :fail
call :confirm_target
if errorlevel 1 goto :cancelled

echo.
echo [5/5] 启动
set "ARGS=--extensionDevelopmentPath="%EXTDIR%" --enable-proposed-api=agentdock.agentdock --new-window"
if "%ISOLATE%"=="1" set "ARGS=%ARGS% --disable-extensions"
if "%MODE%"=="check" (
	echo   仅预检，不启动。将要执行的命令是：
	echo     "%CODE%" %ARGS% "%TARGET%"
	goto :done
)
start "" "%CODE%" %ARGS% "%TARGET%"
echo       已启动

:done
echo.
echo ---------- 在打开的窗口里怎么做 ----------
if "%MODE%"=="check" (
	echo 【本次是 /check，没有真的打开窗口】
	echo 下面这些是真正启动后该看到的：
)
echo   1. 左侧活动栏 AgentDock 图标【或命令面板 AgentDock: 打开对话面板】
echo   2. 面板输入框发一句需求，例如：
echo        把 seed-a.ts 的函数拆成两个，并新建 seed-c.ts 导出常量
echo   3. sidecar 在第一次发送时才启动：届时才会多出一个命令行为
 echo        bun ... packages\sidecar\src\main.ts 的进程【你本来就在跑别的 bun 不算】
echo   4. 编辑器里应同时出现三样东西：
echo        - new 侧整行底色
echo        - hunk 上方的 old 侧灰行【inset】
echo        - hunk 上方的 Accept / Reject CodeLens
echo      文档第 0 行还有 Accept All / Reject All / 前一个 / k/N / 后一个；
echo      editor/title 右上角出现 4 个图标；侧栏 Changes 显示 +N -M、行右 √ ×、悬停 diff、点行跳转
echo   5. 逐 hunk 按 Reject 之后，用 git 对账【在本窗口之外开一个终端】：
echo        cd /d "%TARGET%"
echo        git status --porcelain
echo        git diff
echo      全部 Reject 后应为空 —— 这就是“逐字节复原”
echo   6. Accept 只记录不改文档：按 Ctrl+Z 应该什么也不发生
echo   7. 中途停：对话面板的“停止”按钮
echo   8. 排障：输出面板的 AgentDock Sidecar；命令 AgentDock: 显示 sidecar 输出 / 重启 sidecar
echo   9. 试用完关掉这个窗口即可，sidecar 随之退出
echo ------------------------------------------
goto :end

rem ============================ 子过程 ============================

:find_code
set "CODE="
if defined VSCODE_EXECUTABLE if exist "%VSCODE_EXECUTABLE%" set "CODE=%VSCODE_EXECUTABLE%"
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not defined CODE if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" set "CODE=%ProgramFiles%\Microsoft VS Code\Code.exe"
if not defined CODE for /f "delims=" %%i in ('where code 2^>nul') do if not defined CODE set "CODE=%%i"
if not defined CODE echo   【警告】找不到 Code.exe —— 请设置环境变量 VSCODE_EXECUTABLE 指向它
if defined CODE echo       %CODE%
exit /b 0

:check_running
tasklist /FI "IMAGENAME eq Code.exe" /NH 2>nul | find /I "Code.exe" >nul
if errorlevel 1 (
	echo       没有 VS Code 在运行，OK
	exit /b 0
)
echo   【警告】检测到 VS Code 正在运行。
echo       --enable-proposed-api 是【启动参数】，已被启动的实例会忽略它，扩展会加载失败。
echo       请完全退出所有 VS Code 窗口后重跑；确实要现在试就加 /force。
exit /b 1

:prep_sandbox
set "TARGET=%TEMP%\agentdock-trial"
if exist "!TARGET!" rd /s /q "!TARGET!"
mkdir "!TARGET!" 2>nul
copy /y "%FIXTURE%\seed-a.ts" "!TARGET!\" >nul
copy /y "%FIXTURE%\seed-b.ts" "!TARGET!\" >nul
echo       沙箱：!TARGET!
where git >nul 2>nul
if errorlevel 1 (
	echo   【提示】没找到 git，跳过基线提交；请自己备份后对比
	exit /b 0
)
pushd "!TARGET!"
git -c init.defaultBranch=main init -q
git add -A
git -c user.name=agentdock -c user.email=trial@local commit -qm base
popd
echo       已建 git 基线：git -C "!TARGET!" status
exit /b 0

:confirm_target
if "!TARGET!"=="%TEMP%\agentdock-trial" exit /b 0
echo       目标目录：!TARGET!
echo   【警告】agent 会真的修改这个目录里的文件，请先 commit 或开分支
set "OK="
set /p "OK=      输入 y 继续："
if /I "!OK!"=="y" exit /b 0
echo       已取消。
exit /b 1

:cancelled
if not "%AGENTDOCK_NO_PAUSE%"=="1" pause
exit /b 1

:usage
echo 用法：
echo   agentdock-try.bat              沙箱试用【默认，安全】
echo   agentdock-try.bat 目录         用你自己的项目
echo   agentdock-try.bat /check       只预检，不启动
echo   agentdock-try.bat /force       跳过运行状态检查
if not "%AGENTDOCK_NO_PAUSE%"=="1" pause
exit /b 0

:fail
echo.
echo 启动失败，没有做任何修改。
if not "%AGENTDOCK_NO_PAUSE%"=="1" pause
exit /b 1

:end
if not "%AGENTDOCK_NO_PAUSE%"=="1" pause
exit /b 0
