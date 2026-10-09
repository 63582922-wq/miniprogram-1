#!/bin/bash
# 双击这个文件即可创建数据库索引。
#
# 它会做的事情：让你粘贴一次小程序密钥（输入时不显示），然后调用云开发接口
# 把 9 条索引建好。密钥只存在于这个窗口的内存里，不写进任何文件。
#
# 如果 macOS 提示「无法打开，因为它来自身份不明的开发者」：
# 右键这个文件 → 打开 → 再点「打开」。

cd "$(dirname "$0")/.." || exit 1

echo ""
echo "════════════════════════════════════════════════"
echo "  尺包 · 创建数据库索引"
echo "════════════════════════════════════════════════"
echo ""
echo "  需要你的小程序密钥："
echo "  mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序密钥"
echo ""
echo "  粘贴后按回车。输入时不显示字符，这是正常的。"
echo ""

read -r -s -p "  小程序密钥: " SECRET
echo ""
echo ""

if [ -z "$SECRET" ]; then
  echo "  没有输入密钥，已取消。"
  echo ""
  read -r -p "  按回车关闭窗口。" _
  exit 1
fi

WX_APPSECRET="$SECRET" node scripts/ensure-indexes.cjs
STATUS=$?

unset SECRET

echo ""
if [ $STATUS -eq 0 ]; then
  echo "  完成。可以去云开发控制台 → 数据库 → 选中集合 → 索引管理"
  echo "  看「命中次数」是否随使用增长，那是索引真的生效的证据。"
else
  echo "  有索引没建成功，上面有具体原因。"
fi
echo ""
read -r -p "  按回车关闭窗口。" _
