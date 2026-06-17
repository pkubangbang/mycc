# CMD (Command Prompt) 速查表 (Cheat Sheet)

---

## 1. 基本概念

| 概念 | 说明 |
|------|------|
| 命令 | CMD 命令不区分大小写 |
| 注释 | 使用 `REM` 或 `::` 进行注释 |
| 变量 | 使用 `%VAR%` 引用变量 |
| 回显 | `@echo off` 关闭命令回显，`echo on` 开启 |
| 退出码 | `%ERRORLEVEL%` 获取上一条命令的退出码 |

---

## 2. 变量

```cmd
REM --- 变量赋值与引用 ---
SET VAR=hello           REM 设置变量（注意：= 两边不能有空格）
ECHO %VAR%              REM 引用变量 -> hello
SET "VAR=hello world"   REM 带空格的变量值，用引号包裹

REM --- 特殊变量 ---
%PATH%                  REM 系统 PATH 环境变量
%USERNAME%              REM 当前用户名
%COMPUTERNAME%          REM 计算机名
%TEMP% / %TMP%          REM 临时文件夹路径
%USERPROFILE%           REM 用户目录
%APPDATA%               REM 应用程序数据目录
%CD%                    REM 当前目录路径
%DATE%                  REM 当前日期
%TIME%                  REM 当前时间
%RANDOM%                REM 随机数 (0~32767)
%ERRORLEVEL%            REM 上一条命令的退出码
%0                      REM 批处理文件自身路径
%1 ~ %9                 REM 批处理参数

REM --- 变量运算 ---
SET /A NUM=5+3          REM 算术运算 -> NUM=8
SET /A NUM=5*3+2        REM -> 17
SET /A NUM=10/3         REM -> 3（整数除法）
SET /A NUM=10%%3        REM -> 1（取模，%% 转义）

REM --- 字符串操作 ---
SET str=hello world
ECHO %str:~0,5%         REM 提取前5个字符 -> hello
ECHO %str:~6,5%         REM 从第7个字符开始取5个 -> world
ECHO %str:~6%           REM 从第7个字符到末尾 -> world
ECHO %str:-=/%          REM 替换 - 为 /（无此字符则不变）
```

---

## 3. 目录与文件操作

```cmd
REM --- 目录操作 ---
DIR                     REM 列出当前目录内容
DIR /W                  REM 宽列表显示
DIR /P                  REM 分页显示
DIR /S                  REM 递归列出子目录
DIR /B                  REM 简洁格式（仅文件名）
DIR *.txt               REM 只显示 .txt 文件
DIR /A:H                REM 只显示隐藏文件
DIR /O:N                REM 按名称排序

CD /D D:\project        REM 切换目录（含盘符切换）
CD ..                   REM 返回上级目录
CD \                    REM 返回根目录
MKDIR mydir             REM 创建目录（别名: MD）
RMDIR mydir             REM 删除空目录（别名: RD）
RMDIR /S /Q mydir       REM 强制删除非空目录（/S 递归，/Q 静默）
TREE                    REM 以树形显示目录结构

REM --- 文件操作 ---
TYPE file.txt           REM 显示文件内容
TYPE file.txt | MORE    REM 分页显示文件内容
COPY src.txt dst.txt    REM 复制文件
COPY /Y src.txt dst.txt REM 复制文件（覆盖不提示）
COPY *.txt D:\backup\   REM 批量复制
MOVE src.txt dst.txt    REM 移动/重命名文件
MOVE *.txt D:\backup\   REM 批量移动
DEL file.txt            REM 删除文件（别名: ERASE）
DEL /F /S /Q *.tmp      REM 强制递归静默删除 .tmp 文件
REN old.txt new.txt     REM 重命名文件（别名: RENAME）
FC file1.txt file2.txt  REM 比较两个文件差异
FIND "text" file.txt    REM 在文件中查找字符串
FIND /I "text" file.txt REM 不区分大小写查找
FIND /C "text" file.txt REM 统计匹配行数
FIND /N "text" file.txt REM 显示行号
MORE file.txt           REM 分页显示
SORT file.txt           REM 排序文件内容
SORT file.txt /O out.txt REM 排序后输出到文件
```

---

## 4. 输入输出与重定向

```cmd
REM --- 重定向 ---
command > file.txt      REM 标准输出重定向到文件（覆盖）
command >> file.txt     REM 标准输出重定向到文件（追加）
command 2> error.txt    REM 标准错误重定向
command > file.txt 2>&1 REM 同时重定向 stdout 和 stderr
command < file.txt      REM 从文件读取标准输入
command1 | command2     REM 管道：command1 输出作为 command2 输入
command > NUL           REM 丢弃标准输出
command 2> NUL         REM 丢弃标准错误
command > NUL 2>&1      REM 丢弃所有输出

REM --- 输入 ---
SET /P NAME=请输入姓名: REM 提示用户输入并存入变量
ECHO Y | DEL *.tmp      REM 自动回答 Y（管道输入）
```

---

## 5. 控制流

### if 条件判断

```cmd
REM --- 比较字符串 ---
IF "%VAR%"=="hello" ECHO 相等
IF NOT "%VAR%"=="" ECHO 非空

REM --- 比较数字 ---
IF %NUM% EQU 5 ECHO 等于5
IF %NUM% NEQ 5 ECHO 不等于5
IF %NUM% LSS 5 ECHO 小于5
IF %NUM% LEQ 5 ECHO 小于等于5
IF %NUM% GTR 5 ECHO 大于5
IF %NUM% GEQ 5 ECHO 大于等于5

REM --- 文件存在判断 ---
IF EXIST file.txt ECHO 文件存在
IF NOT EXIST file.txt ECHO 文件不存在

REM --- ERRORLEVEL 判断 ---
IF ERRORLEVEL 1 ECHO 上一条命令失败
IF %ERRORLEVEL% EQU 0 ECHO 成功

REM --- 组合条件 ---
IF EXIST file.txt IF %ERRORLEVEL% EQU 0 ECHO 文件存在且成功
```

### for 循环

```cmd
REM --- 遍历文件 ---
FOR %f IN (*.txt) DO ECHO %f
FOR %f IN (file1.txt file2.txt) DO TYPE %f

REM --- 遍历数字范围 ---
FOR /L %i IN (1,1,10) DO ECHO %i

REM --- 遍历目录 ---
FOR /D %d IN (*) DO ECHO %d

REM --- 递归遍历文件 ---
FOR /R . %f IN (*.txt) DO ECHO %f

REM --- 解析文件内容 ---
FOR /F "tokens=1,2" %i IN (data.txt) DO ECHO %i %j
FOR /F "delims=, tokens=1-3" %i IN (data.csv) DO ECHO %i %j %k
FOR /F "skip=1" %i IN (file.txt) DO ECHO %i

REM --- 命令输出解析 ---
FOR /F "tokens=*" %i IN ('dir /B') DO ECHO %i

REM --- 批处理中 for 变量需用 %% ---
REM FOR %%f IN (*.txt) DO ECHO %%f
```

### goto 与标签

```cmd
REM --- 标签与跳转 ---
IF "%VAR%"=="exit" GOTO :EOF
IF "%VAR%"=="loop" GOTO :mylabel

:mylabel
ECHO 跳转到这里
GOTO :EOF              REM 跳转到文件末尾（退出）

REM --- 子过程 ---
CALL :subroutine arg1 arg2
GOTO :EOF

:subroutine
ECHO 参数1: %1
ECHO 参数2: %2
GOTO :EOF
```

---

## 6. 批处理文件 (.bat / .cmd)

```cmd
@echo off
REM 这是一个批处理文件示例
SETLOCAL ENABLEDELAYEDEXPANSION

REM --- 参数处理 ---
ECHO 脚本名: %0
ECHO 参数1: %1
ECHO 参数2: %2
ECHO 参数个数: %*
SHIFT                    REM 左移参数（%2 变成 %1）

REM --- 延迟变量扩展 ---
REM 在循环中修改变量时需要使用延迟扩展
SET count=0
FOR %%i IN (1 2 3) DO (
    SET /A count+=1
    REM 使用 !count! 而不是 %count%
    ECHO !count!
)

ENDLOCAL
```

---

## 7. 网络命令

```cmd
PING 8.8.8.8             REM 测试网络连通性
PING -n 5 8.8.8.8        REM 发送5个包
PING -t 8.8.8.8          REM 持续 ping（Ctrl+C 停止）

IPCONFIG                 REM 查看 IP 配置
IPCONFIG /ALL            REM 查看详细 IP 配置
IPCONFIG /FLUSHDNS       REM 刷新 DNS 缓存

TRACERT 8.8.8.8          REM 路由追踪
PATHPING 8.8.8.8         REM 路由追踪 + 丢包统计

NETSTAT -AN              REM 查看所有网络连接
NETSTAT -AN | FIND "LISTEN"  REM 查看监听端口
NETSTAT -B               REM 查看连接对应的进程（需管理员）

NSLOOKUP example.com     REM DNS 查询

TELNET host port         REM Telnet 连接测试

CURL https://api.example.com  REM HTTP 请求（Windows 10+ 内置）
```

---

## 8. 系统管理

```cmd
REM --- 进程管理 ---
TASKLIST                 REM 列出所有进程
TASKLIST /V              REM 详细进程信息
TASKLIST /FI "IMAGENAME eq notepad.exe"  REM 按名称过滤
TASKKILL /IM notepad.exe /F  REM 强制结束进程
TASKKILL /PID 1234 /F    REM 按 PID 结束进程

REM --- 服务管理 ---
NET START                REM 列出正在运行的服务
NET START servicename    REM 启动服务
NET STOP servicename     REM 停止服务
SC QUERY servicename     REM 查询服务状态
SC CONFIG servicename START= auto  REM 设置服务为自动启动

REM --- 系统信息 ---
SYSTEMINFO               REM 查看系统详细信息
VER                      REM 查看 Windows 版本
WMIC OS GET Caption,Version  REM 查看操作系统信息
WMIC CPU GET Name,NumberOfCores  REM 查看 CPU 信息
WMIC MEMORYCHIP GET Capacity,Speed  REM 查看内存信息
DRIVERQUERY              REM 列出所有驱动程序

REM --- 磁盘管理 ---
CHKDSK C:                REM 检查磁盘错误
CHKDSK C: /F             REM 检查并修复磁盘错误（需管理员）
CHKDSK C: /R             REM 检查并恢复坏扇区（需管理员）
DISKPART                 REM 磁盘分区工具（交互式）
FSUTIL VOLUME DISKFREE C:  REM 查看磁盘剩余空间

REM --- 用户管理 ---
WHOAMI                   REM 查看当前用户
WHOAMI /USER             REM 查看当前用户名
WHOAMI /GROUPS           REM 查看当前用户所属组
NET USER                 REM 列出所有用户
NET USER username password /ADD  REM 创建用户
NET LOCALGROUP Administrators username /ADD  REM 将用户加入管理员组
```

---

## 9. 任务计划

```cmd
SCHTASKS /QUERY           REM 列出所有计划任务
SCHTASKS /CREATE /SC DAILY /TN "MyTask" /TR "C:\script.bat" /ST 09:00
REM 创建每天9点执行的任务

SCHTASKS /DELETE /TN "MyTask" /F  REM 删除任务
SCHTASKS /RUN /TN "MyTask"       REM 立即运行任务
SCHTASKS /END /TN "MyTask"       REM 停止任务
```

---

## 10. 实用技巧

```cmd
REM --- 清屏 ---
CLS

REM --- 查看命令帮助 ---
command /?               REM 几乎所有命令都支持 /? 查看帮助
HELP                     REM 列出所有可用命令
HELP command             REM 查看命令帮助

REM --- 历史命令 ---
DOSKEY /HISTORY          REM 显示命令历史
按 F7 键                  REM 图形化选择历史命令
按 F3 键                  REM 重复上一条命令

REM --- 快捷键 ---
Tab                      REM 自动补全路径/文件名
Ctrl+C                   REM 中断当前命令
Ctrl+S                   REM 暂停输出（Ctrl+Q 恢复）
F7                       REM 显示命令历史列表
F8                       REM 循环显示历史命令
F9                       REM 按编号选择历史命令
方向键 上/下              REM 浏览历史命令

REM --- 多命令 ---
command1 & command2      REM 顺序执行（无论成功与否）
command1 && command2     REM 条件执行（前一个成功才执行下一个）
command1 || command2     REM 条件执行（前一个失败才执行下一个）
(command1 & command2) > file.txt  REM 组合命令重定向

REM --- 转义字符 ---
^                        REM 转义特殊字符：^| ^& ^< ^> ^^
ECHO 管道符号: ^|         REM 输出: 管道符号: |
ECHO 重定向: ^>           REM 输出: 重定向: >

REM --- 剪贴板操作 ---
command | CLIP           REM 将命令输出复制到剪贴板
DIR | CLIP               REM 将目录列表复制到剪贴板

REM --- 等待 ---
TIMEOUT /T 5             REM 等待5秒
TIMEOUT /T 5 /NOBREAK    REM 等待5秒（不可跳过）
PAUSE                    REM 按任意键继续
SLEEP 5                  REM 等待5秒（需安装 Windows Resource Kit）

REM --- 颜色设置 ---
COLOR 0A                 REM 设置背景色和前景色
REM 颜色代码: 0=黑 1=蓝 2=绿 3=青 4=红 5=紫 6=黄 7=白
REM           8=灰 9=亮蓝 A=亮绿 B=亮青 C=亮红 D=亮紫 E=亮黄 F=亮白
```

---

## 11. 常用命令速查

| 命令 | 说明 | 示例 |
|------|------|------|
| `ECHO` | 输出文本 | `ECHO Hello World` |
| `ECHO.` | 输出空行 | `ECHO.` |
| `TYPE` | 显示文件内容 | `TYPE file.txt` |
| `FIND` | 查找字符串 | `FIND "text" file.txt` |
| `FINDSTR` | 增强查找（支持正则） | `FINDSTR "error" *.log` |
| `SORT` | 排序 | `SORT file.txt` |
| `MORE` | 分页显示 | `MORE file.txt` |
| `FC` | 文件比较 | `FC file1.txt file2.txt` |
| `COMP` | 逐字节比较 | `COMP file1.txt file2.txt` |
| `XCOPY` | 增强复制 | `XCOPY src dst /E /I` |
| `ROBOCOPY` | 高级复制（Windows 7+） | `ROBOCOPY src dst /MIR` |
| `ATTRIB` | 查看/修改文件属性 | `ATTRIB +H file.txt` |
| `ASSOC` | 查看/修改文件关联 | `ASSOC .txt=txtfile` |
| `FTYPE` | 查看/修改文件类型命令 | `FTYPE txtfile=%SystemRoot%\system32\NOTEPAD.EXE %1` |
| `SHUTDOWN` | 关机/重启 | `SHUTDOWN /S /T 0` |
| `SHUTDOWN /R` | 重启 | `SHUTDOWN /R /T 0` |
| `SHUTDOWN /L` | 注销 | `SHUTDOWN /L` |
| `SHUTDOWN /H` | 休眠 | `SHUTDOWN /H` |
| `DATE` | 查看/设置日期 | `DATE` |
| `TIME` | 查看/设置时间 | `TIME` |
| `POWERCFG` | 电源管理 | `POWERCFG /LIST` |
| `MSTSC` | 远程桌面连接 | `MSTSC /V:hostname` |
| `REG` | 注册表操作 | `REG QUERY HKLM\Software` |
| `REG ADD` | 添加注册表项 | `REG ADD HKLM\Software\MyApp /v Key /t REG_SZ /d Value` |
| `REG DELETE` | 删除注册表项 | `REG DELETE HKLM\Software\MyApp /f` |
| `REG EXPORT` | 导出注册表 | `REG EXPORT HKLM\Software\MyApp backup.reg` |
| `REG IMPORT` | 导入注册表 | `REG IMPORT backup.reg` |

---

## 12. FINDSTR 正则表达式

```cmd
REM FINDSTR 是 CMD 中最强大的文本搜索工具

REM --- 基本用法 ---
FINDSTR "error" log.txt              REM 查找包含 error 的行
FINDSTR /I "error" log.txt           REM 不区分大小写
FINDSTR /V "error" log.txt           REM 不包含 error 的行
FINDSTR /C:"hello world" log.txt     REM 精确匹配短语（含空格）
FINDSTR /N "error" log.txt           REM 显示行号
FINDSTR /M "error" *.log             REM 只显示文件名
FINDSTR /R "error.*timeout" log.txt  REM 正则匹配
FINDSTR /S "error" *.log             REM 递归搜索子目录

REM --- 多条件 ---
FINDSTR "error warn fail" log.txt    REM 匹配任一关键词（空格分隔为 OR）
FINDSTR /B "ERROR" log.txt           REM 行首匹配
FINDSTR /E "failed" log.txt          REM 行尾匹配
FINDSTR /G:patterns.txt log.txt      REM 从文件读取匹配模式

REM --- 正则元字符 ---
.         REM 任意字符
*         REM 前一个字符零次或多次
^         REM 行首
$         REM 行尾
[abc]     REM 字符集
[a-z]     REM 字符范围
[^abc]    REM 排除字符集
\<        REM 词首
\>        REM 词尾
\(...\)   REM 分组（FINDSTR 不支持）

REM --- 示例 ---
FINDSTR "^[0-9]" data.txt            REM 以数字开头的行
FINDSTR "\<ERROR\>" log.txt          REM 匹配完整单词 ERROR
FINDSTR "1[0-9][0-9]\." ip.txt      REM 匹配 100-199. 开头的 IP
FINDSTR /I "error" *.log | FINDSTR /V "deprecated"  REM 管道组合过滤
```

---

## 13. 批处理实用模式

```cmd
@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

REM --- 检查管理员权限 ---
NET SESSION >NUL 2>&1
IF %ERRORLEVEL% NEQ 0 (
    ECHO 请以管理员身份运行此脚本
    PAUSE
    EXIT /B 1
)

REM --- 遍历文件并处理 ---
FOR %%f IN (*.log) DO (
    ECHO 处理文件: %%f
    FINDSTR /I "ERROR" "%%f" > "%%~nf_errors.txt"
)

REM --- 获取当前日期（区域相关） ---
FOR /F "tokens=1-3 delims=/-. " %%a IN ('ECHO %DATE%') DO (
    SET YYYY=%%c
    SET MM=%%a
    SET DD=%%b
)
ECHO 日期: %YYYY%-%MM%-%DD%

REM --- 获取当前时间 ---
FOR /F "tokens=1-3 delims=:." %%a IN ('ECHO %TIME%') DO (
    SET HH=%%a
    SET MM=%%b
    SET SS=%%c
)
ECHO 时间: %HH%:%MM%:%SS%

REM --- 日志函数 ---
SET LOGFILE=script.log
CALL :LOG "脚本开始"
CALL :LOG "处理完成"
GOTO :EOF

:LOG
ECHO [%DATE% %TIME%] %* >> %LOGFILE%
ECHO %*
GOTO :EOF

ENDLOCAL
```

---

> **提示：** CMD 中善用 `command /?` 查看帮助，善用 `Tab` 键自动补全路径，善用 `F7` 查看命令历史。对于复杂任务，建议使用 PowerShell 替代 CMD。
