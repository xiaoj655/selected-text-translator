# Selected Text Translator

Selected Text Translator 是一款基于语言模型的 Chrome 翻译插件。

https://github.com/user-attachments/assets/a11618dc-b0d9-4e21-b8f1-ac6ddacdd537

## 功能

| 功能项 | 非 `qwen-mt` 系列模型 | `qwen-mt` 系列模型 |
| --- | --- | --- |
| 单个单词音标 | 有 | 无 |
| 单个单词释义 | 有 | 无 |
| 单个单词场景理解 | 有 | 无 |
| 流式输出 | 无 | 有 |

<img src="https://oss.0x0.asia/single-word.png" />

## 使用方式

### 获取代码

两种方式，任选其一：

- 在 github 页面下载 zip 包，然后解压
- `git clone https://github.com/xiaoj655/selected-text-translator.git --depth=1`

### 安装插件

1. 进入 [Chrome 插件管理页面](chrome://extensions/) 确保开启了开发者模式 (Developer mode)

2. 加载插件源码, 点击左上角的 “加载已解压的扩展程序” (Load unpacked)，选择刚才下载到本地的源码目录即可

### 配置

推荐使用 qwen-mt 系列模型，同时推荐选用 `qwen-mt-flash` 以获得质量和速度均衡的体验。

在 [阿里云百炼平台-apikey管理页](https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key) 
获取一个 apikey， 填入插件配置页即可快速开始使用。
