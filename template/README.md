# 比赛仓库模板

每场比赛的仓库从这里建。现在还要手工建，“开赛”命令建好以后是一条命令。

一个比赛仓库里要有：

- 根目录的三个入口文件：`AGENTS.md`、`CLAUDE.md`、`.kiro/steering/hackathon-kit.md`（从手册仓库根目录原样拷）
- `skill/` 和 `kit/`（从手册仓库原样拷，比赛中不改）
- `.gitattributes` 和 `.gitignore`（原样拷）
- `state/`（用这个目录下的 `state/`，是空的）

拷好以后，先运行 `node kit/kit.mjs schedule ...` 登记比赛时间，再各自“开工”。

带不带底座和做好的素材，先对这场比赛的规则。
