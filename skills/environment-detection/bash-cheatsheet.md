# Bash Cheatsheet

以下是一份从基础到进阶的 Bash 快速参考，特别涵盖了 `grep`、`sed` 和 `jq`。

---

## 1. Bash 基础语法

### 1.1 变量与运算符

| 操作 | 示例 |
|---|---|
| 定义变量 | `VAR="hello"` |
| 使用变量 | `echo $VAR` |
| 字符串拼接 | `greeting="Hello, ${name}!"` |
| 默认值 | `echo ${VAR:-default}` |
| 字符串长度 | `${#VAR}` |
| 提取子串 | `${VAR:0:3}` |
| 替换首个 | `${VAR/old/new}` |
| 全部替换 | `${VAR//old/new}` |
| 删除前缀 | `${VAR#prefix}` |
| 删除后缀 | `${VAR%suffix}` |
| 算术运算 | `echo $(( 5 + 3 * 2 ))` |
| 自增自减 | `(( i++ ))` |
| 命令替换 | `DATE=$(date +%Y-%m-%d)` |

### 1.2 条件判断

```bash
# if-elif-else
if [ "$VAR" == "hello" ]; then
    echo "Matched"
elif [ -z "$VAR" ]; then
    echo "Variable is empty"
else
    echo "No match"
fi

# 双括号推荐用于字符串比较
if [[ "$VAR" =~ ^[0-9]+$ ]]; then
    echo "It's a number"
fi

# 三元条件
[[ -n "$VAR" ]] && echo "Has value" || echo "Empty"
```

**常用测试条件：**

| 测试 | 含义 |
|---|---|
| `-z "$VAR"` | 字符串为空 |
| `-n "$VAR"` | 字符串非空 |
| `-e file` | 文件存在 |
| `-f file` | 是普通文件 |
| `-d dir` | 是目录 |
| `-r file` | 可读 |
| `-w file` | 可写 |
| `-x file` | 可执行 |
| `$VAR -eq 5` | 数字等于 |
| `$VAR -gt 5` | 数字大于 |
| `"a" == "b"` | 字符串相等 (用 `[[ ]]`) |

### 1.3 循环

```bash
# for 循环
for i in {1..10}; do
    echo $i
done

# for 循环遍历数组
for item in "${array[@]}"; do
    echo "$item"
done

# C 风格 for 循环
for (( i=0; i<10; i++ )); do
    echo $i
done

# while 循环
while read -r line; do
    echo "$line"
done < file.txt

# until 循环
until [ $count -ge 10 ]; do
    ((count++))
done

# case 语句
case "$VAR" in
    start)  echo "Starting..." ;;
    stop)   echo "Stopping..."  ;;
    *)      echo "Unknown: $VAR" ;;
esac
```

### 1.4 数组与关联数组

```bash
# 普通数组
arr=("apple" "banana" "cherry")
echo ${arr[0]}           # apple
echo ${arr[@]}           # apple banana cherry
echo ${#arr[@]}          # 3 (长度)
arr+=("date")            # 追加元素

# 关联数组（需要 bash 4+）
declare -A config
config[host]="localhost"
config[port]=8080
echo ${config[host]}     # localhost
```

### 1.5 函数

```bash
# 定义函数
greet() {
    local name="$1"
    echo "Hello, $name!"
    return 0
}

# 调用函数
greet "World"

# 带返回值
get_date() {
    echo "$(date +%Y-%m-%d)"
}
TODAY=$(get_date)
```

### 1.6 重定向与管道

| 操作 | 含义 |
|---|---|
| `cmd > file` | 标准输出重定向到文件（覆盖） |
| `cmd >> file` | 标准输出重定向到文件（追加） |
| `cmd 2> file` | 标准错误重定向到文件 |
| `cmd 2>&1` | 标准错误合并到标准输出 |
| `cmd > file 2>&1` | 同时重定向 stdout 和 stderr |
| `cmd < file` | 从文件读取标准输入 |
| `cmd1 | cmd2` | 管道：cmd1 的输出作为 cmd2 的输入 |
| `cmd > /dev/null 2>&1` | 丢弃所有输出 |
| `cmd <<< "text"` | Here-string：将文本作为输入 |

### 1.7 特殊变量

| 变量 | 含义 |
|---|---|
| `$0` | 脚本名 |
| `$1 $2 $3...` | 位置参数 |
| `$#` | 参数个数 |
| `$@` | 所有参数（每个独立引用） |
| `$*` | 所有参数（作为单个字符串） |
| `$?` | 上一条命令的退出状态码 |
| `$$` | 当前脚本 PID |
| `$!` | 最近一个后台命令的 PID |

---

## 2. grep -- 文本搜索

### 2.1 基本用法

```bash
grep "pattern" file.txt            # 搜索匹配行
grep -i "pattern" file.txt         # 不区分大小写
grep -v "pattern" file.txt         # 反向匹配（不包含 pattern 的行）
grep -c "pattern" file.txt         # 统计匹配行数
grep -n "pattern" file.txt         # 显示行号
grep -w "word" file.txt            # 全词匹配
grep -o "pattern" file.txt         # 只输出匹配部分
grep -l "pattern" *.txt            # 只输出包含匹配的文件名
grep -L "pattern" *.txt            # 只输出不匹配的文件名
grep -r "pattern" .                # 递归搜索当前目录
grep -rn "pattern" .               # 递归搜索 + 行号
grep -rI "pattern" .               # 递归搜索，跳过二进制文件
grep --include="*.py" -r "pattern" .  # 只搜索 .py 文件
```

### 2.2 上下文控制

```bash
grep -A 3 "error" log.txt          # 匹配行 + 后 3 行
grep -B 2 "error" log.txt          # 匹配行 + 前 2 行
grep -C 5 "error" log.txt          # 匹配行 + 前后各 5 行
```

### 2.3 正则表达式

```bash
# 基本正则（BRE，默认）
grep "foo.*bar" file.txt           # . 匹配任意字符，* 匹配零次或多次
grep "^[0-9]" file.txt             # 以数字开头的行
grep "[a-z]\{3\}" file.txt         # 连续3个小写字母

# 扩展正则（ERE，使用 -E 或 egrep）
grep -E "foo|bar" file.txt         # 匹配 foo 或 bar
grep -E "[0-9]+" file.txt          # 一个或多个数字
grep -E "(foo|bar)" file.txt       # 分组
grep -E "[0-9]{2,4}" file.txt      # 2-4位数字

# PCRE（Perl 兼容正则，使用 -P，仅 GNU grep 支持）
grep -P "\d{3}-\d{4}" file.txt     # \d 表示数字
grep -P "\bword\b" file.txt        # 单词边界

# POSIX 字符类
grep "[[:alpha:]]" file.txt        # 字母
grep "[[:digit:]]" file.txt        # 数字
grep "[[:alnum:]]" file.txt        # 字母和数字
grep "[[:space:]]" file.txt        # 空白字符
grep "[[:upper:]]" file.txt        # 大写字母
```

### 2.4 常用组合示例

```bash
# 查找包含 "ERROR" 但不包含 "deprecated" 的行
grep "ERROR" log.txt | grep -v "deprecated"

# 递归搜索，排除目录
grep -r --exclude-dir=node_modules --exclude-dir=.git "pattern" .

# 从管道中搜索
ps aux | grep "nginx"

# 提取所有邮箱地址
grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' contacts.txt

# 统计日志中各错误类型出现次数
grep -oE '\[ERROR\][^ ]*' app.log | sort | uniq -c | sort -rn
```

---

## 3. sed -- 流编辑器

### 3.1 替换

```bash
sed 's/old/new/' file.txt           # 每行替换第一个匹配
sed 's/old/new/g' file.txt          # 每行全局替换
sed 's/old/new/2' file.txt          # 替换每行第2个匹配
sed 's/old/new/gi' file.txt         # 全局替换 + 不区分大小写
sed -i 's/old/new/g' file.txt       # 原地修改（GNU sed / Linux）
sed -i '' 's/old/new/g' file.txt    # 原地修改（BSD sed / macOS）
sed -i.bak 's/old/new/g' file.txt   # 原地修改 + 创建备份
```

### 3.2 多命令

```bash
# 使用 -e 执行多个命令
sed -e 's/foo/bar/g' -e 's/baz/qux/g' file.txt

# 使用分号
sed 's/foo/bar/g; s/baz/qux/g' file.txt

# 使用 sed 脚本文件
sed -f script.sed file.txt
```

### 3.3 行地址

```bash
sed '5d' file.txt                   # 删除第5行
sed '5,10d' file.txt                # 删除第5-10行
sed '5,$d' file.txt                  # 删除第5行到末尾
sed '1d' file.txt                    # 删除第1行（去标题行）
sed '$d' file.txt                    # 删除最后一行
sed '1d;$d' file.txt                 # 删除首行和末行
sed '/pattern/d' file.txt            # 删除匹配 pattern 的行
sed '/pattern/!d' file.txt           # 删除不匹配 pattern 的行
sed '/^$/d' file.txt                 # 删除空行
sed '/^#/d' file.txt                 # 删除注释行
sed '/^#/d; /^$/d' file.txt          # 删除注释行和空行
```

### 3.4 打印指定范围

```bash
sed -n '5p' file.txt                # 只打印第5行
sed -n '5,10p' file.txt             # 打印第5-10行
sed -n '/start/,/end/p' file.txt    # 打印 start 到 end 之间的行
sed -n '/pattern/p' file.txt        # 只打印匹配 pattern 的行
sed -n '/pattern/!p' file.txt       # 只打印不匹配的行
sed -n '1~2p' file.txt              # 打印奇数行
sed -n '2~2p' file.txt              # 打印偶数行
```

### 3.5 插入与追加

```bash
sed '2a\插入的新行' file.txt          # 在第2行后追加
sed '2i\插入的新行' file.txt          # 在第2行前插入
sed '$a\最后一行' file.txt           # 在文件末尾追加
sed '2c\替换整行内容' file.txt        # 替换第2行整行
sed 's/^/# /' file.txt              # 在每行行首加注释
sed 's/$/ SUFFIX/' file.txt         # 在每行行尾加后缀
```

### 3.6 捕获组与反向引用

```bash
# BRE 风格（默认）
sed 's/\(.*\),\(.*\)/\2 \1/' file.txt   # 交换逗号前后的内容

# ERE 风格（-E / -r）
sed -E 's/([0-9]{4})-([0-9]{2})-([0-9]{2})/\2\/\3\/\1/' file.txt  # 日期格式转换

# & 引用整个匹配
sed 's/[0-9]/[&]/g' file.txt        # 给每个数字加方括号

# 大小写转换
sed 's/\(.*\)/\U\1/' file.txt       # 整行转大写
sed 's/\(.*\)/\L\1/' file.txt       # 整行转小写
sed 's/^./\u&/' file.txt            # 首字母大写
```

### 3.7 实用示例

```bash
# 去除行首/行尾空白
sed 's/^[[:space:]]*//' file.txt
sed 's/[[:space:]]*$//' file.txt
sed 's/^[[:space:]]*//;s/[[:space:]]*$//' file.txt

# 压缩多个空格为一个
sed 's/  */ /g' file.txt

# 删除 HTML 标签
sed 's/<[^>]*>//g' file.txt

# 在多个文件中查找替换
grep -rl "oldtext" . | xargs sed -i 's/oldtext/newtext/g'

# 转换 CSV 分隔符为 TSV
sed 's/,/\t/g' file.csv
```

### 3.8 高级：Hold Space

```bash
sed G file.txt                      # 每行后插入空行（双倍行距）
sed '/^$/d;G' file.txt              # 删除已有空行后再双倍行距
sed 'n;d' file.txt                  # 撤销双倍行距
sed '1h;2,$G' file.txt              # 反转文件内容
```

---

## 4. jq -- JSON 处理器

### 4.1 基本操作

```bash
# 美化打印 JSON
echo '{"name":"Alice","age":30}' | jq '.'
jq '.' data.json                    # 从文件读取
curl -s https://api.example.com | jq '.'  # 从 API 读取

# 提取字段
jq '.name' data.json               # 提取 name 字段
jq '.user.email' data.json         # 提取嵌套字段
jq '.user.address?.city?' data.json # 安全访问（不存在返回 null）

# 数组操作
jq '.items[0]' data.json           # 第一个元素
jq '.items[-1]' data.json          # 最后一个元素
jq '.items[1:4]' data.json         # 切片 [1,4)
jq '.items[]' data.json            # 遍历数组每个元素
jq '.items | length' data.json     # 数组长度

# 对象操作
jq 'keys' data.json                # 获取所有键（排序）
jq 'keys_unsorted' data.json       # 获取所有键（保持原序）
jq 'values' data.json              # 获取所有值
jq 'has("name")' data.json         # 检查键是否存在
jq 'to_entries' data.json          # {k:v} -> [{key:k, value:v}]
jq 'from_entries' data.json        # [{key:k, value:v}] -> {k:v}
```

### 4.2 常用命令行选项

| 选项 | 含义 |
|---|---|
| `-r` | 原始输出（字符串不带引号） |
| `-c` | 紧凑输出（单行） |
| `-s` | 将所有输入读入一个数组 |
| `-n` | 不读取输入（用 null 作为输入） |
| `-R` | 将每行作为字符串读取 |
| `-S` | 排序对象键 |
| `-e` | 如果最后输出为 null/false 则退出码为 1 |
| `--arg NAME VALUE` | 传入字符串变量 $NAME |
| `--argjson NAME JSON` | 传入 JSON 值变量 $NAME |
| `--slurpfile NAME FILE` | 将文件内容读入 $NAME |

### 4.3 管道与组合

```bash
# 管道：左边的输出作为右边的输入
jq '.users[] | .name' data.json

# 逗号：输出多个结果
jq '.name, .email' data.json

# 构建新对象
jq '{name: .user.name, age: .user.age}' data.json

# 简写：{name} 等价于 {name: .name}
jq '.users[] | {name, email}' data.json

# 构建数组
jq '[.users[] | .name]' data.json

# 字符串插值
jq -r '.[] | "Name: \(.name), Age: \(.age)"' data.json
```

### 4.4 过滤与选择

```bash
# select 条件过滤
jq '.[] | select(.age > 30)' data.json
jq '.[] | select(.status == "active")' data.json
jq '.[] | select(.name == "Alice" and .age > 25)' data.json
jq '.[] | select(.city | startswith("New"))' data.json
jq '.[] | select(.tags | contains(["go"]))' data.json

# map + select
jq 'map(select(.active == true))' data.json

# 去重
jq 'unique' data.json               # 去重
jq 'unique_by(.id)' data.json       # 按字段去重
```

### 4.5 数组操作

```bash
# map 映射
jq 'map(.price * 2)' data.json      # 每个元素 x2
jq 'map(.name)' data.json           # 提取每个对象的 name

# 排序
jq 'sort' data.json                # 排序
jq 'sort_by(.name)' data.json       # 按字段排序
jq 'sort_by(.date) | reverse' data.json  # 倒序

# 分组
jq 'group_by(.type)' data.json      # 按 type 分组

# 聚合
jq '[.[].price] | add' data.json    # 求和
jq '[.[].price] | add / length' data.json  # 平均值
jq 'max_by(.price)' data.json       # 最大值元素
jq 'min_by(.price)' data.json       # 最小值元素

# 修改数组
jq '.items |= map(select(. > 2))' data.json  # 原位过滤
jq '.list += [3]' data.json         # 追加元素
jq 'del(.list[1])' data.json       # 删除索引1的元素
```

### 4.6 对象操作

```bash
# 添加/修改键
jq '. + {"city": "NYC"}' data.json       # 合并新键
jq '.city = "NYC"' data.json             # 设置键值
jq '.version = "2.0.0"' package.json    # 更新版本

# 删除键
jq 'del(.password, .token)' data.json   # 删除多个键

# 深度合并
jq '. * {a:{y:9}}' data.json             # 递归合并
jq '. + {a: 2}' data.json                # 浅合并（右覆盖左）

# with_entries 转换
jq 'with_entries(.value *= 2)' data.json    # 所有值 x2
jq 'with_entries(.key |= "prefix_" + .)' data.json  # 所有键加前缀
```

### 4.7 字符串操作

```bash
jq -r '.name | ascii_upcase' data.json     # 转大写
jq -r '.name | ascii_downcase' data.json   # 转小写
jq -r '.tags | join(", ")' data.json       # 数组连接为字符串
jq '.name | length' data.json              # 字符串长度
jq '.name | split(" ")' data.json         # 字符串分割为数组
jq '.url | startswith("http")' data.json  # 前缀检测
jq -r '.text | gsub("old"; "new")' data.json  # 全局替换
jq -r '.text | sub("old"; "new")' data.json   # 首个替换
jq -r '.text | test("^foo")' data.json    # 正则测试
jq '.text | match("[0-9]+")' data.json    # 正则匹配
```

### 4.8 高级操作

```bash
# 递归搜索（任意深度）
jq '.. | .email? // empty' data.json      # 找出所有 email 字段
jq '.. | objects | select(has("id"))' data.json  # 所有有 id 的对象

# reduce 聚合
jq 'reduce .[] as $x (0; . + $x.price)' data.json  # 自定义求和
jq 'reduce .[] as $x ({}; . + {($x.k): $x.v})' data.json  # 构建对象

# 条件表达式
jq '.[] | if .active then .name else empty end' data.json

# 传入外部变量
jq --arg name "Bob" '. + {name: $name}' <<< '{}'
jq --argjson count 42 '.count = $count' <<< '{}'

# JSON Lines / NDJSON 处理
cat events.ndjson | jq -c 'select(.level == "error")'  # 过滤错误日志
cat events.ndjson | jq -s '.'                          # 合并为数组
echo '[{"a":1}]' | jq -c '.[]'                         # 转为 NDJSON
```

### 4.9 输出格式化

```bash
# CSV 输出
jq -r '.[] | [.id, .name, .email] | @csv' data.json

# TSV 输出
jq -r '.[] | [.id, .name] | @tsv' data.json

# 带表头的 CSV
jq -r '(["id","name","email"]), (.[] | [.id, .name, .email]) | @csv' data.json

# 格式化文本输出
jq -r '.[] | "\(.name): $\(.price * 100)% CPU"' data.json
```

### 4.10 实战常见模式

```bash
# 从 API 提取数据
curl -s https://api.github.com/users/octocat | jq -r '.login, .name, .public_repos'

# kubectl: 提取所有 Running 状态的 Pod 名称
kubectl get pods -o json | jq -r '.items[] | select(.status.phase=="Running") | .metadata.name'

# Docker: 获取正在运行的容器镜像名
docker inspect $(docker ps -q) | jq -r '.[].Config.Image' | sort -u

# 提取 token 用于后续命令
TOKEN=$(curl -s -X POST auth.example.com/token | jq -r '.access_token')
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data

# 合并多个 JSON 文件
jq -s '.[0] * .[1]' config1.json config2.json

# 在脚本中修改 JSON 文件（原地修改）
jq '.version = "2.0"' config.json > tmp && mv tmp config.json
# 或者使用 sponge（来自 moreutils）
jq '.version = "2.0"' config.json | sponge config.json
```

---

## 5. 实用管道组合

```bash
# 统计日志中 Top 10 IP
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10

# 在所有 Python 文件中查找替换函数名
grep -rl "old_func" . --include="*.py" | xargs sed -i 's/old_func/new_func/g'

# 实时监控错误日志
tail -f app.log | grep --line-buffered "ERROR"

# JSON 日志中提取错误消息
cat app.ndjson | jq -r 'select(.level=="error") | "\(.timestamp) \(.message)"'

# 统计文件中各类型行数
grep -c "ERROR" log.txt; grep -c "WARN" log.txt; grep -c "INFO" log.txt

# 合并两个 JSON API 响应并去重
jq -s 'add | unique_by(.id)' resp1.json resp2.json

# 从 JSON 提取数据后用 sed 格式化
curl -s api.example.com/users | jq -r '.[] | "\(.id)\t\(.name)"' | column -t

# 从 API 获取数据，提取字段，生成 CSV
curl -s api.example.com/users | jq -r '(["ID","Name","Email"]), (.[] | [.id, .name, .email]) | @csv' > users.csv
```

---

## 6. 注意事项

| 注意点 | 说明 |
|---|---|
| **sed -i 兼容性** | Linux 用 `sed -i`，macOS 用 `sed -i ''`，跨平台用 `sed -i.bak` |
| **grep 正则引擎** | 默认 BRE，`-E` 用 ERE，`-P` 用 PCRE（仅 GNU grep 支持） |
| **jq 引号** | 外层用单引号包裹 jq 程序，内部字符串用双引号 |
| **jq -r** | 输出给 shell 变量或 xargs 时一定要加 `-r` 去掉引号 |
| **jq null 处理** | 用 `?` 抑制错误，用 `// default` 提供默认值 |
| **shell 变量** | bash 变量赋值时 `=` 两边不能有空格 |
| **文件名空格** | 使用 `find -print0 | xargs -0` 处理含空格文件名 |
