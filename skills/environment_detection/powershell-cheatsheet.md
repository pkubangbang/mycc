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
