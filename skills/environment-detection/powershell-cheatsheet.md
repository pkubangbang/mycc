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

### ⚠️ 转义与特殊字符 (Escaping & Special Characters) — 解决引号/插值/特殊符号摩擦

**这是写 PowerShell 命令时第二高频的坑（仅次于编码）。** 摩擦的根源：PowerShell 的转义符是反引号 `` ` `` (grave accent, ASCII 96)，**不是** Bash 的反斜杠 `\`；且转义序列**只在双引号字符串内才被解释**。把 Bash/CMD 的直觉套过来会反复踩雷。

> **来源：** [about_Special_Characters — Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_special_characters)

#### 转义符：反引号 `` ` `` （不是反斜杠 `\`）

PowerShell 用反引号 `` ` `` 作为转义字符，**大小写敏感**。Bash 用 `\`，CMD 用 `^` —— 三者完全不同，切勿混用。

| 转义序列 | 含义 | 备注 |
|----------|------|------|
| `` `0 `` | Null | 文件中的 null 终止符；不等同于 `$null` 变量 |
| `` `a `` | Alert (响铃) | 触发系统蜂鸣 |
| `` `b `` | Backspace | 光标回退一格，**不删除**字符 |
| `` `f `` | Form feed | 仅影响打印，不影响屏幕 |
| `` `n `` | 换行 (New line) | 插入换行；最常用 |
| `` `r `` | 回车 (Carriage return) | 回到行首并**覆盖**后续内容 |
| `` `t `` | 水平制表符 | 跳到下一个 tab stop |
| `` `v `` | 垂直制表符 | 渲染依终端而定（Windows Terminal 当作 CRLF） |
| `` `e `` | Escape (ESC) | **PS6+ 新增**，5.1 无；ANSI/虚拟终端序列（颜色、加粗等） |
| `` `u{x} `` | Unicode 转义 | **PS6+ 新增**，5.1 无；按十六进制码点输出字符（1–6 位，上限 10FFFF，含 emoji） |

#### 🆕 版本差异 (PowerShell 7 vs 5.1) — 转义序列的差异高亮

**对比来源：** Microsoft Learn `about_Special_Characters` 的 [5.1 版](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_special_characters?view=powershell-5.1) 与 [7.5 版](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_special_characters?view=powershell-7.5)。

> PowerShell 6 起新增了 **两个** 转义序列，Windows 自带的 **5.1 完全没有**。其余转义序列（`` `0 `a `b `f `n `r `t `v ``）、转义符 `` ` ``、"只在双引号内生效"规则、行延续、`--`、`--%`、`~` —— **两版本完全一致**。

| 转义序列 | 含义 | 5.1 | 7+ (自 PS6) | 用途 |
|----------|------|:---:|:---:|------|
| `` `e `` | Escape (ESC, ASCII 27) | ❌ 无 | ✅ 有 | ANSI/虚拟终端转义序列：改颜色、加粗、下划线、光标定位 |
| `` `u{x} `` | Unicode 转义 | ❌ 无 | ✅ 有 | 按十六进制码点输出任意 Unicode 字符（1–6 位 hex，上限 `10FFFF`，支持 emoji 与 BMP 之外字符）|

**`` `e `` 示例（仅 PS7+）— ANSI 颜色：**

```powershell
# PS7+：输出绿色文字（5.1 会把 `e 当字面文本，不生效）
$fgColor = 32  # green
"`e[${fgColor}mGreen text`e[0m"   # -> 绿色的 "Green text"
# 检测主机是否支持虚拟终端序列：
$Host.UI.SupportsVirtualTerminal
```

**`` `u{x} `` 示例（仅 PS7+）— Unicode 字符：**

```powershell
# PS7+：按码点输出字符（5.1 会把 `u{...} 当字面文本）
"`u{2195}"      # -> ↕ (上下双箭头)
"`u{1F44D}"     # -> 👍 (thumbs up emoji，BMP 之外)
"`u{0041}"      # -> A
```

**跨版本兼容写法（同时在 5.1 和 7 上跑）：**

```powershell
# ESC 字符：5.1 没有 `e，用 [char]27 构造
$esc = [char]27                 # 5.1 与 7 通用
"$esc[32mGreen text$esc[0m"     # 7 上也可用此写法（`e 只是语法糖）

# Unicode 字符：5.1 没有 `u{x}，用 [char]::ConvertFromUtf32 构造
$arrow = [char]::ConvertFromUtf32(0x2195)   # 5.1 与 7 通用 -> ↕
$thumb = [char]::ConvertFromUtf32(0x1F44D)  # -> 👍
```

> **速记：** 写跨版本脚本时，用 `[char]27` 代替 `` `e ``、用 `[char]::ConvertFromUtf32(0xXXXX)` 代替 `` `u{XXXX} `` —— 两者在 5.1 和 7 上行为一致，避免版本分叉。mycc 在 Windows 上默认用 PowerShell 7 (pwsh) 执行命令，故 `` `e `` / `` `u{x} `` 通常可直接用；仅当目标明确是 5.1 时才需要回退到 `[char]` 写法。

#### ⚠️ 关键规则：转义序列只在双引号内生效

`` ` `` 转义**只在双引号 `"..."` 字符串中被解释**。在单引号 `'...'` 中，反引号是**字面字符**，不做任何转义。

```powershell
"Line1`nLine2"     # 双引号 -> `n 被解释 -> 两行
'Line1`nLine2'     # 单引号 -> `n 是字面文本 -> "Line1`nLine2"（原样）
```

**推论 — 想让 `` ` `` 转义生效，必须用双引号；想让 `` ` `` 保持字面，用单引号。** 这是单/双引号选择的核心依据之一（见下表）。

#### 单引号 vs 双引号（选哪一个？）

| 引号 | 变量插值 `$var` | 子表达式 `$(...)` | 转义序列 `` `n `` 等 | 反引号本身 `` ` `` | 适用场景 |
|------|:---:|:---:|:---:|:---:|------|
| `'...'` 单引号 | ❌ 不插值 | ❌ 不求值 | ❌ 字面 | 字面 | **字面字符串**（含 `$`、`` ` ``、路径、正则、JSON 片段）|
| `"..."` 双引号 | ✅ 插值 | ✅ 求值 | ✅ 解释 | 转义符 | 需要插值/换行/制表时 |

**高频摩擦与解法：**

```powershell
# 摩擦 1：想在双引号里输出字面 $（变量名被插值了）
"Price is $5"            # ❌ $5 被当作变量插值 -> "Price is "（$5 为空）
'Price is $5'            # ✅ 单引号，字面 -> "Price is $5"
"Price is `$5"           # ✅ 双引号 + 反引号转义 $ -> "Price is $5"

# 摩擦 2：想在字符串里输出字面反引号 ` 本身
'Use the ` char'         # ✅ 单引号里 ` 是字面 -> "Use the ` char"
"Use the `` char"        # ✅ 双引号里用 `` 转义出一个字面 ` -> "Use the ` char"

# 摩擦 3：双引号里嵌套双引号
"He said "hi""           # ❌ 引号提前闭合，解析错误
"He said `"hi`""         # ✅ 用 `" 转义内层双引号 -> He said "hi"
'He said "hi"'           # ✅ 更简单：外层用单引号 -> He said "hi"

# 摩擦 4：单引号里想输出字面单引号
'It's'                   # ❌ 单引号内无法用 ` 转义（` 在单引号里是字面）
'It''s'                  # ✅ 单引号用双写 '' 表示一个字面 ' -> It's
```

> **速记口诀：** 单引号 = 字面王道（唯一例外是 `'` 自身要 `''` 双写）；双引号 = 插值 + `` ` `` 转义。含 `$` 或 `` ` `` 又不需要插值 → 优先单引号。

#### 行延续 (Line continuation)

反引号放在一行**末尾**表示命令延续到下一行（等价于 Bash 的 `\` 换行）：

```powershell
Get-Process | Where-Object { $_.CPU -gt 10 } |
    Sort-Object CPU -Descending |
    Select-Object -First 5      # 管道 `|` 天然换行，无需反引号

# 显式行延续（无天然换行符时）
curl.exe -X POST https://api.example.com/items `
    -H "Content-Type: application/json" `
    -d '{"name":"widget"}'
```

> **注意：** 反引号行延续后**不能有任何尾随空格**，否则延续失效。能用 `|`、`{` `}`、`(` `)` 等天然换行点时优先用它们，比反引号更稳健。

#### 停止解析标记 `--%`（Stop-parsing token）

`--%` 让其后的所有内容按**字面**传递给外部程序，PowerShell **不再**解释为命令/表达式/变量。用于把含 `$`、`()`、`{}` 等的参数原样传给 exe（如 `icacls`、`cmd.exe`）。

```powershell
# `--%` 之后的 $HOME 不被插值，原样传给 cmd
cmd.exe /c echo $HOME --% $HOME
# -> 第一处 $HOME 被 PowerShell 插值为路径，第二处 $HOME 字面输出

icacls X:\VMS --% /grant Dom\HVAdmin:(CI)(OI)F
# `--%` 之后整串原样传给 icacls，括号等不被 PowerShell 解析
```

> **限制：** `--%` 之后**不能**再用 PowerShell 变量插值；`--%` 之前的变量仍正常插值。环境变量 `%VAR%` 风格在 `--%` 之后会被展开。

#### 结束参数标记 `--`（End-of-parameters）

`--` 表示其后的值作为**纯参数**传递（如同被双引号包裹），不被当作参数名解析。用于输出以 `-` 开头的字面字符串：

```powershell
Write-Output -- -InputObject     # -> -InputObject（不会被当成参数）
```

#### 波浪号 `~`（Tilde 展开）

`~` 在路径**开头**时展开为用户主目录，在路径其他位置是**字面字符**：

```powershell
Copy-Item ~/notes.txt D:\backup\        # ~ -> C:\Users\student
Copy-Item D:\data~1\file.txt .          # 这里的 ~ 是字面，不展开
```

#### mycc 上下文：bash 工具如何执行你的命令

mycc 的 bash 工具在 Windows 上通过 `powershell -EncodedCommand <Base64(UTF-16LE)>` 执行你输入的命令（见 mindmap「PowerShell -EncodedCommand」），**整条命令被 Base64 编码后整体送入**，因此：

- **你不需要**为绕过分号 `;` / 引号嵌套而额外转义 —— 编码传递避免了 shell 层的二次解析摩擦。
- 但命令**内部**传给外部 exe 的参数仍按上面的 PowerShell 引用/转义规则处理（单双引号、`` ` `` 转义、`--%` 都照常生效）。
- **优先用内置工具**读写源码：`read_file` / `edit_file` / `write_file` 不经过 shell 解析，`old_text`/`new_text`/`content` 按字面匹配，彻底回避引号与转义摩擦。只有必须走 shell 管道（`Get-Content -Encoding UTF8` 切片、`curl.exe`、调用 exe 传含 `$` 的参数）时，才需要手写转义。
- **PowerShell 5.1 限定：** 该版本不支持 `&&`/`||` 管道链运算符、`??`/`??=` 空合并、`-Encoding utf8NoBOM`；用 `;`/`if ($?)`、`if ($null -eq $x) {...}`、.NET `WriteAllText` 替代（参见「命令连接符」与「文件编码」两节）。

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
