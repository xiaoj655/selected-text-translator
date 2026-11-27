# Selected 鸿蒙阅读器

这是面向 MatePad 的鸿蒙原生阅读器，使用 ArkTS 和 ArkUI。支持 HarmonyOS 5.0.2（API 14）及以上的原生鸿蒙设备。

## 在 MatePad 上运行

1. 用 DevEco Studio 打开 `harmony` 目录，并安装 HarmonyOS 5.1.0（API 18）或兼容的 SDK。
2. 在 MatePad 上启用开发者选项和 USB 调试，将设备连接到电脑，并确认设备上的调试授权。
3. 在 DevEco Studio 的 **File → Project Structure → Signing Configs** 中勾选 **Support HarmonyOS** 和 **Automatically generate signature**，按提示登录华为开发者账号。选择连接的 MatePad，运行 `entry`。

手动签名也可以使用为该设备配置的调试证书和 Profile。调试签名包含调试设备授权。签名材料和密码保存在本地，勿提交到仓库。[华为调试应用指南](https://developer.huawei.com/consumer/en/doc/app/agc-help-debug-overview-0000001955332054/)

## 阅读和查询

1. 点「试读示例」，或点「添加文章」后粘贴英文正文。可单独填写标题，正文按换行分段。
2. 在「模型设置」填写 OpenAI 兼容服务的 HTTPS 地址、模型名称和 API Key。默认地址和模型为阿里云百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1` 和 `qwen3.8-flash`。可清空 API Key 后保存以移除原凭据。
3. 在「查词」模式轻点单词获取对应语境的英文释义。点「查看整句」，或切换到「查句」模式后轻点正文，查看整句的简明英文解释。
4. 宽屏横向窗口在右侧显示结果，窄窗口在底部显示。书架保存文章和最近读到的段落，点同一篇文章可继续阅读。

文章和进度存放在应用本地沙箱。API Key 存放在系统安全存储中。查询会把选中文字和必要的句内上下文发给配置的模型服务。

## 命令行构建和验证

在仓库根目录使用支持原生 TypeScript 的 Node.js 22.18+ 运行验证。

```sh
node --test harmony/test/*.test.mjs
node harmony/scripts/generate-reader-prompt.mjs --check
```

在 `harmony` 目录使用华为 Command Line Tools 5.1.0 生成 HAP。Linux 可将工具目录的 `bin` 加入 `PATH` 后运行。

```sh
ohpm install --all
hvigorw --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

未配置签名时，输出为 `entry/build/default/outputs/default/entry-default-unsigned.hap`。这个包需要配置设备调试签名后才能在商用 MatePad 上安装。
