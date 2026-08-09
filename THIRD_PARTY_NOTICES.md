# Third Party Notices

本文件列出 Agent Dev Platform 中引用、借鉴或改编的第三方开源项目。

## CC Switch

- **项目**：cc-switch — https://github.com/farion1231/cc-switch
- **研究版本**：commit `413c09e0790c304506888ae24b9be72820aca126`（v3.19.2）
- **License**：MIT License
- **Copyright**：Copyright (c) 2025 Jason Young

### 借鉴内容

Agent Dev Platform v2.4.0 Smart API Onboarding 功能在以下方面参考了 CC Switch 的设计与实现：

- **Deep Link 协议格式**：`ccswitch://v1/import?resource=provider&...` 的 URL 结构与参数命名。
- **Provider Preset 思想**：显式声明 `apiFormat` / `settingsConfig` 模板，将厂商预设与线协议分离。
- **Provider 配置数据结构**：`settingsConfig.env`（Claude/Anthropic）与 `settingsConfig.auth + config.toml`（Codex）的字段组织方式。
- **配置导入流程**：Deep Link 优先、本地配置只读、用户主动触发的设计原则。

### 实现方式

- **未直接复制 CC Switch 源码**。所有代码为基于其设计思想的独立实现。
- **未将 CC Switch 打包为依赖**。Agent Dev Platform 不依赖 CC Switch 运行时。
- **未修改 CC Switch 的任何数据**。导入功能只读取用户主动提供的配置文本 / Deep Link。

### MIT License

```
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
