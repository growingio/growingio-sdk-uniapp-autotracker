# SDK 发布

本流程交付 npm 包 `gio-uniapp-sdk` 和 GitHub Release 的 `uni_modules` 附件，模块 ID 为 `gio-uniapp-autotracker`。DCloud 插件市场上架需另行准备框架版本声明和版本说明。

## 发布前检查

1. 在发布 PR 中更新根目录的 `package.json` 版本。等 **SDK Code Tests** 检查通过后，将 PR 合并到 `master`。
2. 等 `master` 上对应提交的 **SDK Code Tests** 检查通过。该次运行保存的 `sdk-candidate` 包含两个交付包和带有完整性摘要的 `release.json`。也可在该提交本地运行 `pnpm install --frozen-lockfile` 和 `pnpm run release:prepare`，产物位于 `dist/release/`。
3. 将 `v<版本>` 标签指向通过检查的 `master` 提交并推送。首次发布新 npm 包时，先完成下节的 npm 审核再推送标签。

标签工作流在构建前检查标签提交是否已进入 GitHub 的 `master` 历史。若 PR 使用 squash 或 rebase 合并，给合并后的 `master` 提交打标签。GitHub Actions 使用标签提交中的工作流，发布时选择已经包含此检查的提交。

## 首次发布到 npm

1. 从 `master` 上目标提交的 **SDK Code Tests** 下载并解压 `sdk-candidate`。以有权创建该包的维护者身份登录 npm，使用 npm CLI 11.15.0 或更高版本。
2. 在产物目录运行以下命令，将 `release.json` 指定的 npm 压缩包提交审核。

   ```sh
   archive=$(node -p 'require("./release.json").npmFile')
   channel=$(node -p 'require("./release.json").tag')
   npm stage publish "./$archive" --tag "$channel" --access public --ignore-scripts
   ```

3. 在 npm 审核队列确认包名、版本及内容，完成双因素认证后批准。
4. 确认 npm 版本已公开后，给生成候选包的同一 `master` 提交打标签并推送。标签工作流会核对已发布 npm 版本的完整性，并补齐 GitHub Release 附件。

[npm 首次发布说明](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)

## 后续版本与失败重跑

准备首次由工作流向 npm 发布新版本时，在 `gio-uniapp-sdk` 的包设置中添加 Trusted Publisher。组织为 `growingio`，仓库为 `growingio-sdk-uniapp-autotracker`，工作流文件为 `release.yml`，Environment 留空，并允许直接发布。添加后需在两天内完成首次成功的可信发布。[npm Trusted Publishing 配置](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)

版本来自根目录的 `package.json`，标签格式为 `v<版本>`。正式版进入 `latest`，预发布版进入 `next`。标签工作流按组串行运行，先保存验证通过的产物，再尝试 npm 发布。新版本完成 npm 内容和渠道核对后，才创建 GitHub Release 并上传附件。

目标版本在 npm 缺失且对应渠道已指向更高版本时，任务以 `release_would_regress_latest` 或 `release_would_regress_next` 失败。已验证的构建产物可从该次运行下载。目标版本已在 npm 发布且内容一致时，重跑可补齐 GitHub Release，即使对应渠道已经前进或移除。

如果首发包尚未创建，可使用同一 `master` 提交的 `sdk-candidate`，或标签运行归档的 `sdk-<标签>` 执行首发步骤，再重跑原标签。遇到摘要不一致时应保留原版本并检查候选包来源。
