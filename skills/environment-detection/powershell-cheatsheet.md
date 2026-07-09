# PowerShell 速查表 (Cheat Sheet)

---

## 1. 基本概念

| 概念 | 说明 |
|------|------|
| Cmdlet | PowerShell 命令，格式为 `动词-名词`，如 `Get-Process` |
| Pipeline `|` | 将前一个命令的输出传递给下一个命令 |
| 变量前缀 `$` | 所有变量以 `$` 开头 |
| 注释 `#` | 单行注释，`<# #>` 多行注释 |
| 不区分大小写 | PowerShell 默认不区分大小写 |

### 命令连接符（与 Bash 的关键差异）

**⚠️ PowerShell 不支持 `&&` 和 `||` 操作符**（这是 Bash/CMD 语法）。在 PowerShell 中连接命令必须使用下表中的运算符：

| Bash 语法 | PowerShell 等价 | 说明 |
|-----------|----------------|------|
| `cmd1 && cmd2` | `cmd1 ; cmd2` | 顺序执行（不检查前一条是否成功）|
| `cmd1 && cmd2` | `if ($?) { cmd2 }` | 仅在前一条成功时执行（语义等价于 `&&`）|
| `cmd1 \|\| cmd2` | `if (-not $?) { cmd2 }` | 仅在前一条失败时执行（语义等价于 `\|\|`）|
| `cmd1 ; cmd2` | `cmd1 ; cmd2` | 顺序执行，无论成功失败（相同）|

```powershell
# ❌ 错误：PowerShell 会把 && 当作参数或报错
agent-browser open "https://example.com" && agent-browser snapshot

# ✅ 正确方式一：用分号顺序执行（不关心前者是否成功）
agent-browser open "https://example.com" ; agent-browser snapshot

# ✅ 正确方式二：用 $? 检查前一条命令是否成功（等价于 &&）
agent-browser open "https://example.com"
if ($?) { agent-browser snapshot }

# ✅ PowerShell 7+ 支持新的管道链运算符（语义与 bash && 一致）
agent-browser open "https://example.com" && agent-browser snapshot
```

> **注意：** PowerShell 7+ 新增了 `&&` 和 `||` 管道链运算符（pipeline chain operators），语义与 Bash 一致。但 Windows 自带的 **PowerShell 5.1 不支持**，为兼容旧版本请使用 `;` 或 `if ($?)`。

---

## 2. 变量与数据类型

```powershell
# --- 变量赋值 ---
$str      = "Hello"           # 字符串
$int      = 42                # 整数
$double   = 3.14              # 浮点数
$bool     = $true             # 布尔值 ($true / $false)
$array    = @(1, 2, 3)        # 数组
$hash     = @{Name="Alice"; Age=30}  # 哈希表
$nullVal  = $null             # 空值

# --- 字符串插值 ---
$name = "World"
"Hello, $name!"                      # 双引号 -> 变量插值 -> Hello, World!
'Hello, $name!'                      # 单引号 -> 不插值 -> Hello, $name!
"Today is $(Get-Date -Format 'yyyy-MM-dd')"  # 子表达式

# --- 类型检查与转换 ---
$str.GetType().FullName              # 查看类型
[int]"123"                           # 类型转换
[string]42                            # -> "42"
[math]::Round(3.14159, 2)            # -> 3.14

# --- 特殊变量 ---
$_       # 当前管道对象
$PSItem  # 同 $_
$?       # 上一条命令是否成功
$$       # 上一条命令的最后一行
$Host    # 当前主机信息
$PID     # 当前进程ID
$Error   # 错误对象数组
$args    # 传递给脚本/函数的参数数组
```

---

## 3. 数组与集合

```powershell
# --- 数组 ---
$arr = @(1, 2, 3, 4, 5)
$arr.Count                          # 元素个数 -> 5
$arr[0]                             # 第一个元素 -> 1
$arr[-1]                            # 最后一个元素 -> 5
$arr[1..3]                          # 切片 -> 2,3,4
$arr += 6                           # 追加元素
$arr -join ", "                     # -> "1, 2, 3, 4, 5, 6"
"a,b,c" -split ","                  # -> @("a","b","c")

# --- 哈希表 ---
$h = @{ Name = "Alice"; Age = 30; City = "Beijing" }
$h.Name                             # -> Alice
$h["Age"]                           # -> 30
$h.Keys                             # 所有键
$h.Values                           # 所有值
$h.Remove("City")                   # 删除键
$h.ContainsKey("Name")              # -> True

# --- 遍历 ---
foreach ($item in $arr) { Write-Host $item }
$arr | ForEach-Object { $_ * 2 }    # 每个元素 x2
$arr | Where-Object { $_ -gt 2 }    # 筛选 >2 的元素
$arr | Sort-Object -Descending      # 降序排序
$arr | Select-Object -First 3       # 取前3个
$arr | Select-Object -Unique         # 去重
$arr | Measure-Object               # 统计 (Count, Sum, Average...)
```

---

## 4. 操作符

### 比较操作符（使用文字而非符号）

```powershell
-eq    # 等于          -> 5 -eq 5  -> True
-ne    # 不等于        -> 5 -ne 3  -> True
-gt    # 大于          -> 5 -gt 3  -> True
-ge    # 大于等于      -> 5 -ge 5  -> True
-lt    # 小于          -> 3 -lt 5  -> True
-le    # 小于等于      -> 5 -le 5  -> True
-like  # 通配符匹配    -> "Hello" -like "H*"   -> True
-notlike              # 通配符不匹配
-match # 正则匹配     -> "abc123" -match '\d+' -> True
-notmatch             # 正则不匹配
-contains  # 数组包含  -> @(1,2,3) -contains 2 -> True
-notcontains          # 数组不包含
-in    # 在数组中      -> 2 -in @(1,2,3)       -> True
-is    # 类型检查      -> "str" -is [string]   -> True
```

### 逻辑操作符

```powershell
-and   # 与    -> $true -and $false  -> False
-or    # 或    -> $true -or $false   -> True
-not   # 非    -> -not $false        -> True
!      # 非    -> !$false            -> True
-xor   # 异或  -> $true -xor $true   -> False
```

### 算术与特殊操作符

```powershell
+    -   *   /   %          # 算术运算
..                            # 范围 -> 1..5 -> @(1,2,3,4,5)
++$i / $i++                   # 自增
--$i / $i--                   # 自减
+=  -=  *=  /=  %=            # 复合赋值
|                             # 管道
&  "command"                 # 调用操作符（执行字符串命令）
$a ?? $b                      # 空合并运算符 (PowerShell 7+)
$a ??= $b                     # 空合并赋值 (PowerShell 7+)
```

---

## 5. 控制流

### if / elseif / else

```powershell
if ($x -gt 10) {
    Write-Host "大"
} elseif ($x -gt 5) {
    Write-Host "中"
} else {
    Write-Host "小"
}
```

### switch

```powershell
switch ($day) {
    "Monday"    { "星期一"; break }
    "Tuesday"   { "星期二"; break }
    default     { "其他" }
}

# 支持通配符
switch -Wildcard ($str) {
    "H*"  { "以H开头"; break }
    "*e"  { "以e结尾"; break }
    default { "未知" }
}

# 支持正则
switch -Regex ($str) {
    "^\d+$"  { "纯数字"; break }
    "^[a-z]+$" { "纯字母"; break }
}
```

### for 循环

```powershell
for ($i = 0; $i -lt 5; $i++) {
    Write-Host "i = $i"
}
```

### foreach 循环

```powershell
foreach ($item in $collection) {
    Write-Host $item
}
```

### while / do-while / do-until

```powershell
# while
while ($i -lt 10) { $i++; Write-Host $i }

# do-while (至少执行一次)
do { $i++ } while ($i -lt 10)

# do-until (直到条件为真)
do { $i++ } until ($i -ge 10)
```

### break / continue

```powershell
# break -> 跳出循环
# continue -> 跳过本次，进入下次
foreach ($i in 1..10) {
    if ($i -eq 5) { break }     # 到5就停
    if ($i % 2 -eq 0) { continue }  # 跳过偶数
    Write-Host $i               # 输出 1,3
}
```

---

## 6. 函数

```powershell
# --- 基本函数 ---
function Say-Hello {
    param(
        [string]$Name = "World",      # 参数 + 默认值
        [int]$Count = 1               # 参数 + 默认值
    )
    for ($i = 0; $i -lt $Count; $i++) {
        Write-Host "Hello, $Name!"
    }
}
Say-Hello -Name "Alice" -Count 3

# --- 带返回值 ---
function Add {
    param([int]$a, [int]$b)
    return $a + $b            # 或直接写 $a + $b（隐式返回）
}
$result = Add 3 5            # -> 8

# --- 高级函数 (支持管道) ---
function Get-EvenNumbers {
    [CmdletBinding()]
    param(
        [Parameter(ValueFromPipeline = $true)]
        [int[]]$InputNumbers
    )
    process {
        foreach ($num in $InputNumbers) {
            if ($num % 2 -eq 0) { Write-Output $num }
        }
    }
}
@(1,2,3,4,5,6) | Get-EvenNumbers    # -> 2, 4, 6
```

---

## 7. 常用 Cmdlet

### 输入输出

```powershell
Write-Host "普通输出" -ForegroundColor Green     # 控制台输出
Write-Output "管道输出"                            # 发送到管道
Write-Warning "警告信息"                          # 黄色警告
Write-Error "错误信息"                             # 红色错误
Write-Debug "调试信息"                             # 调试（需 -Debug）
Write-Verbose "详细信息"                           # 详细（需 -Verbose）

Read-Host "请输入姓名"           # 读取输入
Read-Host "密码" -AsSecureString  # 安全输入
```

### 文件系统

```powershell
Get-ChildItem .                    # 列出当前目录 (别名: ls, dir)
Get-ChildItem . -Recurse -Filter *.txt   # 递归查找 .txt 文件
Set-Location C:\                    # 切换目录 (别名: cd)
Get-Location                        # 当前目录 (别名: pwd)
Copy-Item src.txt dst.txt          # 复制文件 (别名: cp)
Move-Item src.txt dst.txt          # 移动/重命名 (别名: mv)
Remove-Item file.txt               # 删除 (别名: rm, del)
New-Item file.txt -ItemType File   # 创建文件 (别名: ni)
New-Item myDir -ItemType Directory # 创建目录
Rename-Item old.txt new.txt        # 重命名
Get-Content file.txt               # 读取文件 (别名: cat, gc)
Set-Content file.txt "内容"        # 写入覆盖 (别名: sc)
Add-Content file.txt "追加"        # 追加 (别名: ac)
Test-Path C:\Windows               # 路径是否存在
Get-Item file.txt | Select-Object FullName, Length, LastWriteTime
```

### ⚠️ 文件编码 (Encoding) — 避免 Windows 乱码的高频陷阱

**这是 Windows 上最容易反复踩的坑之一。** Windows PowerShell 5.1 的 `Get-Content` / `Set-Content` / `Out-File` / `Add-Content` **默认使用系统 ANSI 代码页**（中文系统为 GBK/GB2312，英文系统为 Windows-1252），而现代源代码文件几乎都是 **UTF-8** 编码。两者不匹配时：

- 读取含中文/日文/韩文/Emoji 等**非 ASCII 字符**的文件 → 显示为乱码 (mojibake)
- 乱码字符的字节宽度与原文不同 → 行号偏移变得**不可靠**
- 用 `Set-Content` 不带 `-Encoding` 写入 → 把 UTF-8 文件**破坏**成 ANSI 编码

> **注意：** 控制台输出编码 (`$OutputEncoding`、`[Console]::OutputEncoding`、`chcp 65001`) 由 mycc 的 bash 工具自动注入，**只解决 stdout 管道编码**。它**不影响** `Get-Content` 读取文件时的解码方式——文件读取的编码由 `-Encoding` 参数决定，与控制台 codepage 无关。所以即使控制台已是 UTF-8，`Get-Content` 不加 `-Encoding UTF8` 仍会乱码。

**规则：在 Windows 上读写源代码文件时，始终显式指定 `-Encoding UTF8`。**

| 操作 | ❌ 错误（默认 ANSI，会乱码） | ✅ 正确（UTF-8） |
|------|------------------------------|------------------|
| 读取 | `Get-Content src/api/mock.js` | `Get-Content src/api/mock.js -Encoding UTF8` |
| 读取片段 | `$lines = Get-Content file; $lines[0..50]` | `$lines = Get-Content file -Encoding UTF8; $lines[0..50]` |
| 写入 | `Set-Content file.txt "内容"` | `Set-Content file.txt "内容" -Encoding UTF8` |
| 追加 | `Add-Content file.txt "行"` | `Add-Content file.txt "行" -Encoding UTF8` |
| 管道输出 | `... \| Out-File out.txt` | `... \| Out-File out.txt -Encoding UTF8` |

**BEFORE / AFTER：**

```powershell
# BEFORE — 中文注释乱码，行号偏移不可信
$lines = Get-Content src/api/mock.js
$lines[1013..1035]   # → 显示为 ï¿½ï¿½ ä¹±ç ï¿½...

# AFTER — 正确显示，行号可信
$lines = Get-Content src/api/mock.js -Encoding UTF8
$lines[1013..1035]   # → 显示为正常的中文注释
```

**BOM 注意事项：**
- **读取**：`-Encoding UTF8` 能正确解析带 BOM 和不带 BOM 的 UTF-8 文件，读取场景无副作用。
- **写入**：PowerShell 5.1 的 `-Encoding UTF8` 会写入 **BOM** (EF BB BF)。大多数编辑器/工具能处理，但某些工具（如某些 `cat`/`diff`/shell 脚本）会把 BOM 当作正文首字符。若需写**无 BOM** 的 UTF-8，用 .NET API：
  ```powershell
  [System.IO.File]::WriteAllText("file.txt", $content, [System.Text.UTF8Encoding]::new($false))
  ```
- PowerShell 7+ 的 `-Encoding utf8NoBOM` 可直接写无 BOM UTF-8，但 5.1 不支持。

**更优方案：优先使用 mycc 内置工具**
mycc 的 `read_file` / `edit_file` / `write_file` 工具内置了 UTF-8（含 BOM 处理），无需关心编码问题。当目标是源代码文件时，优先用这些工具而非手写 `Get-Content`：
```
read_file(path="src/api/mock.js")          # 自动 UTF-8
edit_file(path="src/api/mock.js", old_text=..., new_text=...)
```
仅在需要行号切片、复杂管道、或批量处理等内置工具不便的场景，才用 `Get-Content -Encoding UTF8`。

**遇到乱码时的恢复策略：**
1. 不要在乱码基础上继续读行号（行号已不可信）。
2. 改用 `grep`（`Select-String`）按**英文锚点**定位，而非依赖行号。
3. 用 `edit_file` 的 `old_text` 精确匹配**英文代码段**（不依赖编码/行号）来修改。
4. 对完整目标区间用 `-Encoding UTF8` **一次性重读**，不要分段试探重复读已失败区间。

### 文本处理

```powershell
"  hello  " .Trim()                 # 去空格 -> "hello"
"hello".ToUpper()                   # -> "HELLO"
"HELLO".ToLower()                   # -> "hello"
"hello world".Split(" ")             # -> @("hello","world")
"hello".Replace("l","L")            # -> "heLLo"
"hello".Substring(0,3)              # -> "hel"
"hello".Length                      # -> 5
"a,b,c" -split ","                  # -> @("a","b","c")
@(1,2,3) -join "-"                  # -> "1-2-3"
```

### 日期与时间

```powershell
Get-Date                                  # 当前日期时间
Get-Date -Format "yyyy-MM-dd HH:mm:ss"   # 格式化
(Get-Date).AddDays(7)                    # 加7天
(Get-Date).AddHours(-2)                  # 减2小时
[datetime]"2024-01-01"                  # 字符串转日期
```

---

### curl 命令 (Windows 内置)

Windows 内置了 `curl.exe`（基于上游 curl 项目），与 Linux/macOS 的 curl 行为一致。

**重要：PowerShell 5.1 的别名冲突**

PowerShell 5.1 定义了一个内置别名 `curl` 指向 `Invoke-WebRequest`，这会遮蔽真正的 `curl.exe`。解决方法：

```powershell
# 方式一：显式使用 curl.exe（推荐）
curl.exe -O https://example.com/file.zip

# 方式二：删除别名（仅当前会话有效）
Remove-Item Alias:curl
curl -O https://example.com/file.zip

# 方式三：在 PowerShell 7+ 中无此问题，直接使用 curl
```

**常见用法：**

```powershell
# 下载文件
curl.exe -O https://example.com/file.zip

# GET 请求并打印响应
curl.exe https://api.example.com/data

# JSON POST 请求
curl.exe -X POST https://api.example.com/items `
    -H "Content-Type: application/json" `
    -d '{"name":"widget"}'

# 查看帮助
curl.exe --help
```

---

## 8. 管道与常用模式

```powershell
# --- 基本管道 ---
Get-Process | Where-Object { $_.CPU -gt 10 }       # CPU > 10的进程
Get-Process | Sort-Object CPU -Descending           # 按CPU降序
Get-Process | Select-Object Name, CPU -First 10     # 取前10
Get-Service | Where-Object Status -eq "Running"     # 运行中的服务

# --- ForEach-Object ---
1..5 | ForEach-Object { $_ * 2 }        # -> 2,4,6,8,10
Get-Process | ForEach-Object { $_.Name }  # 列出所有进程名

# --- Where-Object 简写 ---
Get-Process | Where-Object { $_.Name -eq "chrome" }
Get-Process | Where-Object Name -eq "chrome"          # 简写形式

# --- Group-Object ---
Get-Process | Group-Object Company      # 按公司分组

# --- Compare-Object ---
$arr1 = @(1,2,3,4); $arr2 = @(3,4,5,6)
Compare-Object $arr1 $arr2              # 对比差异

# --- Tee-Object (分流) ---
Get-Process | Tee-Object -FilePath procs.txt | Select-Object -First 5
# 保存到文件的同时输出到管道
```

---

## 9. 错误处理

```powershell
# --- try / catch / finally ---
try {
    $result = 10 / 0
} catch {
    Write-Host "错误: $($_.Exception.Message)"
} finally {
    Write-Host "总会执行"
}

# --- 捕获特定异常 ---
try {
    Get-Content "nonexistent.txt" -ErrorAction Stop
} catch [System.Management.Automation.ItemNotFoundException] {
    Write-Host "文件不存在"
} catch {
    Write-Host "其他错误: $_"
}

# --- ErrorAction 参数 ---
Get-ChildItem -ErrorAction SilentlyContinue  # 静默忽略错误
Get-ChildItem -ErrorAction Stop              # 错误转为异常(可被catch)
Get-ChildItem -ErrorAction Continue          # 显示错误但继续(默认)
Get-ChildItem -ErrorAction Inquire           # 提示用户
```

---

## 10. 远程执行与作业

```powershell
# --- 后台作业 ---
Start-Job -ScriptBlock { Start-Sleep 5; "Done" }
Get-Job                              # 查看作业状态
Receive-Job -Id 1                    # 获取结果
Wait-Job -Id 1                       # 等待完成
Remove-Job -Id 1                     # 删除作业

# --- 远程会话 ---
Enter-PSSession -ComputerName "Server01"
Invoke-Command -ComputerName "Server01" -ScriptBlock { Get-Process }
```

---

## 11. 模块管理

```powershell
Get-Module -ListAvailable            # 列出所有可用模块
Import-Module ActiveDirectory        # 导入模块
Get-Command -Module ActiveDirectory  # 列出模块命令
Install-Module PSReadLine -Force     # 安装模块 (需PSGet)
Remove-Module ActiveDirectory        # 卸载模块
Find-Module "*Active*"               # 在线搜索模块
```

---

## 12. 常用别名对照

| 别名 | 完整命令 | 说明 |
|------|---------|------|
| `ls` / `dir` | `Get-ChildItem` | 列目录 |
| `cd` | `Set-Location` | 切目录 |
| `pwd` | `Get-Location` | 当前目录 |
| `cp` / `copy` | `Copy-Item` | 复制 |
| `mv` / `move` | `Move-Item` | 移动 |
| `rm` / `del` | `Remove-Item` | 删除 |
| `cat` / `gc` | `Get-Content` | 读文件 |
| `sc` | `Set-Content` | 写文件 |
| `ac` | `Add-Content` | 追加 |
| `ni` | `New-Item` | 新建 |
| `%` | `ForEach-Object` | 遍历 |
| `?` | `Where-Object` | 筛选 |
| `select` | `Select-Object` | 选择 |
| `sort` | `Sort-Object` | 排序 |
| `gci` | `Get-ChildItem` | 列目录 |
| `gps` | `Get-Process` | 进程 |
| `gsv` | `Get-Service` | 服务 |
| `start` | `Start-Process` | 启动进程 |
| `echo` | `Write-Output` | 输出 |
| `cls` | `Clear-Host` | 清屏 |
| `measure` | `Measure-Object` | 统计 |

---

## 13. 实用速查

```powershell
# --- 帮助 ---
Get-Help Get-Process                 # 基本帮助
Get-Help Get-Process -Detailed        # 详细帮助
Get-Help Get-Process -Examples       # 示例
Get-Help Get-Process -Full            # 完整文档
Update-Help                          # 更新帮助文件
Get-Command -Verb Get                 # 查所有 Get- 开头的命令
Get-Alias                             # 所有别名
Get-Member                            # 查看对象属性方法

# --- 对象成员检查 ---
Get-Process | Get-Member              # 查看类型和成员
$object | Get-Member -MemberType Property    # 仅属性
$object | Get-Member -MemberType Method      # 仅方法

# --- 格式化输出 ---
Get-Process | Format-Table Name, CPU  # 表格
Get-Process | Format-List             # 列表
Get-Process | Format-Wide              # 宽列表
Get-Process | Out-GridView              # GUI 窗口 (仅Windows)
Get-Process | Out-File procs.txt       # 输出到文件
Get-Process | Export-Csv procs.csv -NoTypeInformation  # 导出CSV
Get-Process | ConvertTo-Json           # 转JSON
Get-Process | ConvertTo-Html            # 转HTML

# --- 执行脚本 ---
.\script.ps1                          # 运行脚本
PowerShell -File script.ps1           # 命令行运行
& "C:\path\script.ps1"               # 使用调用操作符

# --- 执行策略 ---
Get-ExecutionPolicy                    # 查看策略
Set-ExecutionPolicy RemoteSigned       # 设置策略 (需管理员)

# --- 环境变量 ---
$env:PATH                             # 读取 PATH
$env:MY_VAR = "value"                 # 设置
Get-ChildItem env:                     # 列出所有环境变量
```

---

## 14. 常用正则表达式示例

```powershell
"phone: 13800138000" -match '(\d{11})'       # -> $Matches[1] = "13800138000"
"2024-01-15" -match '(\d{4})-(\d{2})-(\d{2})'
# $Matches[1]="2024" $Matches[2]="01" $Matches[3]="15"

"hello world" -replace 'world','PowerShell'  # -> "hello PowerShell"
"abc123def456" -replace '\d+', '#'           # -> "abc#def#"
[regex]::Matches("a1b2c3", '\d') | ForEach-Object { $_.Value }  # -> 1,2,3
```

---

> **提示：** 在 PowerShell 中善用 **Tab 键**自动补全，善用 `Get-Help` 和 `Get-Member` 探索命令，这是最高效的学习方式！
