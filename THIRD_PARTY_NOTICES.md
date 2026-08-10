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

## Cline SDK

- **项目**：cline — https://github.com/cline/cline
- **包名**：`@cline/sdk`（npm）
- **研究版本**：0.0.72（pre-1.0，仅 ESM）
- **研究提交**：`b3cee3f973ffe9d023a10c5c414deba68cd6e09d`
- **License**：Apache License 2.0
- **Copyright**：Copyright (c) Cline contributors

### 引用方式

- **以独立 Sidecar 依赖形式引用**：`@cline/sdk` 及其生产依赖随 `resources/cline-runtime/sidecar/node_modules` 分发。
- **ESM 加载**：独立 Node 22 Sidecar 加载 ESM；Electron 主进程不导入生产 SDK。
- **Node 引擎要求**：>= 22。
- **未修改 Cline 源码**：生产路径仅通过公开 `ClineCore` 生命周期与事件 API 调用。
- **二进制分发**：安装包包含 npm 发布的 SDK 与生产依赖；各包自带的 license/notice 文件保留在 Sidecar 依赖树中。

### Apache License 2.0

```
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the
copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other
entities that control, are controlled by, or are under common control with
that entity. For the purposes of this definition, "control" means (i) the
power, direct or indirect, to cause the direction or management of such
entity, whether by contract or otherwise, or (ii) ownership of fifty
percent (50%) or more of the outstanding shares, or (iii) beneficial
ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications,
including but not limited to software source code, documentation source,
and configuration files.

"Object" form shall mean any form resulting from mechanical transformation
or translation of a Source form, including but not limited to compiled
object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form,
made available under the License, as indicated by a copyright notice that
is included in or attached to the work (an example is provided in the
Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form,
that is based on (or derived from) the Work and for which the editorial
revisions, annotations, elaborations, or other modifications represent, as
a whole, an original work of authorship. For the purposes of this License,
Derivative Works shall not include works that remain separable from, or
merely link (or bind by name) to the interfaces of, the Work and Derivative
Works thereof.

"Contribution" shall mean any work of authorship, including the original
version of the Work and any modifications or additions to that Work or
Derivative Works thereof, that is intentionally submitted to Licensor for
inclusion in the Work by the copyright owner or by an individual or Legal
Entity authorized to submit on behalf of the copyright owner. For the
purposes of this definition, "submitted" means any form of electronic,
verbal, or written communication sent to the Licensor or its
representatives, including but not limited to communication on electronic
mailing lists, source code control systems, and issue tracking systems that
are managed by, or on behalf of, the Licensor for the purpose of discussing
and improving the Work, but excluding communication that is conspicuously
marked or otherwise designated in writing by the copyright owner as "Not a
Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on
behalf of whom a Contribution has been received by Licensor and
subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable copyright license to
reproduce, prepare Derivative Works of, publicly display, publicly perform,
sublicense, and distribute the Work and such Derivative Works in Source or
Object form.

3. Grant of Patent License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
this section) patent license to make, have made, use, offer to sell, sell,
import, and otherwise transfer the Work, where such license applies only to
those patent claims licensable by such Contributor that are necessarily
infringed by their Contribution(s) alone or by combination of their
Contribution(s) with the Work to which such Contribution(s) was submitted.
If You institute patent litigation against any entity (including a
cross-claim or counterclaim in a lawsuit) alleging that the Work or a
Contribution incorporated within the Work constitutes direct or
contributory patent infringement, then any patent licenses granted to You
under this License for that Work shall terminate as of the date such
litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or
Derivative Works thereof in any medium, with or without modifications, and
in Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a
copy of this License; and

(b) You must cause any modified files to carry prominent notices stating
that You changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You
distribute, all copyright, patent, trademark, and attribution notices from
the Source form of the Work, excluding those notices that do not pertain to
any part of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution,
then any Derivative Works that You distribute must include a readable copy
of the attribution notices contained within such NOTICE file, excluding
those notices that do not pertain to any part of the Derivative Works, in
at least one of the following places: within a NOTICE text file distributed
as part of the Derivative Works; within the Source form or documentation,
if provided along with the Derivative Works; or, within a display generated
by the Derivative Works, if and wherever such third-party notices normally
appear. The contents of the NOTICE file are for informational purposes only
and do not modify the License. You may add Your own attribution notices
within Derivative Works that You distribute, alongside or as an addendum to
the NOTICE text from the Work, provided that such additional attribution
notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may
provide additional or different license terms and conditions for use,
reproduction, or distribution of Your modifications, or for any such
Derivative Works as a whole, provided Your use, reproduction, and
distribution of the Work otherwise complies with the conditions stated in
this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any
Contribution intentionally submitted for inclusion in the Work by You to
the Licensor shall be under the terms and conditions of this License,
without any additional terms or conditions. Notwithstanding the above,
nothing herein shall supersede or modify the terms of any separate license
agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade
names, trademarks, service marks, or product names of the Licensor, except
as required for reasonable and customary use in describing the origin of
the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to
in writing, Licensor provides the Work (and each Contributor provides its
Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied, including, without limitation, any
warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining
the appropriateness of using or redistributing the Work and assume any risks
associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether
in tort (including negligence), contract, or otherwise, unless required by
applicable law (such as deliberate and grossly negligent acts) or agreed to
in writing, shall any Contributor be liable to You for damages, including
any direct, indirect, special, incidental, or consequential damages of any
character arising as a result of this License or out of the use or
inability to use the Work (including but not limited to damages for loss of
goodwill, work stoppage, computer failure or malfunction, or any and all
other commercial damages or losses), even if such Contributor has been
advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work
or Derivative Works thereof, You may choose to offer, and charge a fee for,
acceptance of support, warranty, indemnity, or other liability obligations
and/or rights consistent with this License. However, in accepting such
obligations, You may act only on Your own behalf and on Your sole
responsibility, not on behalf of any other Contributor, and only if You
agree to indemnify, defend, and hold each Contributor harmless for any
liability incurred by, or claims asserted against, such Contributor by reason
of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

To apply the Apache License to your work, attach the following boilerplate
notice, with the fields enclosed by brackets "[]" replaced with your own
identifying information. (Don't include the brackets!) The text should be
enclosed in the appropriate comment syntax for the file format. We also
recommend that a file or class name and description of purpose be included
on the same "printed page" as the copyright notice for easier
identification within third-party archives.

Copyright (c) Cline contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Node.js Runtime

- **项目**：Node.js — https://github.com/nodejs/node
- **分发版本**：`22.23.2` Windows x64 official binary distribution
- **来源**：`https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip`
- **SHA-256**：`1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`
- **用途**：仅用于执行 Cline Sidecar；不替换 Electron 自带的 Node 运行时。
- **许可证与 notices**：官方分发包的 `LICENSE` 被原样保留为 `resources/cline-runtime/node/LICENSE`。该文件包含 Node.js 许可及官方二进制分发要求保留的第三方许可/notice。

## Cline transitive dependencies

Sidecar dependencies are exactly locked by `sidecars/cline-runtime/package-lock.json` and distributed as the npm production tree. Package `LICENSE`, `LICENSE-*`, `NOTICE`, and metadata files remain alongside the distributed modules. The authoritative inventory is the lockfile and packaged tree, not a manually copied aggregate license dump.

## OpenCode

- **项目**：opencode — https://github.com/anomalyco/opencode
- **研究版本**：v1.18.15
- **License**：MIT License
- **Copyright**：Copyright (c) Anomaly Software

### 引用方式

- **以外部 CLI / HTTP 服务器形式集成**：Agent Dev Platform 不打包 OpenCode，而是探测 `PATH` 中的 `opencode` 可执行文件（`opencode --version`）。
- **托管子进程**：以子进程方式启动 `opencode serve`（默认 `127.0.0.1:4096`），通过其 HTTP / SSE API 通信。
- **未修改 OpenCode 源码**：仅调用其公开 HTTP 端点（`/session`、`/session/:id/message`、`/session/:id/abort`、`/event` 等）。
- **未二次分发**：OpenCode 由用户本机安装，Agent Dev Platform 不随源码重新发布 OpenCode。

### MIT License

```
MIT License

Copyright (c) Anomaly Software

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

## OpenHands

- **项目**：OpenHands Agent Server — https://github.com/OpenHands/software-agent-sdk
- **主仓库**：https://github.com/OpenHands/OpenHands
- **研究版本**：v1.41.0（`openhands-agent-server`）
- **License**：MIT License
- **Copyright**：Copyright (c) OpenHands

### 引用方式

- **以外部服务器形式集成**：Agent Dev Platform 不打包 OpenHands，而是以子进程方式启动本地 `openhands.agent_server`（`python -m openhands.agent_server`）。
- **REST + WebSocket 通信**：通过其 HTTP API（`/conversations`、`/conversations/{id}/events`）与 WebSocket（`/conversations/{id}/events/socket`）通信。
- **鉴权**：可选 `OH_SESSION_API_KEY`（`X-Session-API-Key` / `Authorization: Bearer` 头），密钥加密经 `OH_SECRET_KEY`。
- **未修改 OpenHands 源码**：仅调用其公开 API。
- **未二次分发**：OpenHands 由用户本机安装，Agent Dev Platform 不随源码重新发布 OpenHands。

### MIT License

```
MIT License

Copyright (c) OpenHands

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
