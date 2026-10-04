# 光伏电站运行维护管理平台

面向电站台账、组串阵列、逆变器、汇流箱、跟踪支架、组件清洗、告警处置与发电结算的一体化光伏电站运行维护工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 电站台账 | `station` | 光伏电站 | 电站编号、电站名称、装机容量 |
| 组串阵列 | `array` | 光伏组串 | 组串编号、所属方阵、组件型号 |
| 逆变器 | `inverter` | 逆变器 | 设备编号、逆变器型号、额定功率 |
| 汇流箱 | `combiner` | 直流汇流箱 | 汇流箱编号、所属方阵、接入组串数 |
| 跟踪支架 | `tracker` | 跟踪支架 | 支架编号、所属方阵、跟踪方式 |
| 组件清洗 | `cleaning` | 清洗任务 | 清洗单号、清洗方阵、清洗方式 |
| 告警事件 | `alarm` | 告警事件 | 告警编号、告警等级、告警来源 |
| 缺陷消缺 | `defect` | 消缺任务 | 缺陷编号、缺陷类别、发现方式 |
| 巡视检查 | `patrol` | 巡视记录 | 巡视单号、巡视路线、巡视人员 |
| 备品备件 | `spare` | 备品备件 | 备件编号、备件名称、适用设备 |
| 电量计量 | `meter` | 关口计量表 | 计量点编号、计量方向、表计型号 |
| 并网调度 | `dispatch` | 调度指令 | 指令编号、调度机构、指令类型 |
| 辐照监测 | `irradiance` | 辐照监测点 | 监测点编号、设备型号、安装高度 |
| 安全工器具 | `tooling` | 安全工器具 | 工器具编号、名称规格、试验类别 |
| 消防设施 | `fire` | 消防器材 | 器材编号、器材类型、布置位置 |
| 发电结算 | `settlement` | 电量结算单 | 结算单号、结算周期、上网电量 |
| 运维合同 | `contract` | 运维合同 | 合同编号、服务范围、合同期限 |
| 运维人员 | `crew` | 运维人员 | 人员编号、姓名、岗位工种 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `pv-plant-ops:entries` 这一项，或调用 `resetModule(模块)`。

## 辐照监测：校准事务、权限与台账（重点约定）

辐照监测模块在通用列表之外多一层业务域，相关代码：

- `frontend/src/data/irradiance-rules.ts`：坏值判定线（缺测 / 超量程 / 峰均倒挂 / 温度越界），
  规则常量 `IRRADIANCE_RULE_VERSION` 即「判定线版本」，改线后把版本加一，已录读数会照新线重放。
- `frontend/src/data/irradiance-domain.ts`：纯函数业务域。安排校准、确认恢复都同时改
  「监测状态 + 当日辐照量口径 + pending/abnormal 标记 + 告警待处置台账」，
  末尾做一致性断言（`assertInvariant`），任一步不成立就抛错、整笔退回。
- `frontend/src/data/ledger.ts`：校准结论落到告警事件模块的「辐照校准待处置台账」，
  同一监测点只有一条未闭环台账；数据异常点数 + 待校准点数必须等于待处置台账条数。
- `frontend/src/api/irradiance-service.ts`：查询（片区筛选 / 辐照量排序坏值沉底 /
  条件随 URL 翻页）、点位定位（找不到时写明是编号格还是筛选格对不上）、
  按点位加锁的动作入口（连点两次只认头一回）。
- 权限在 `frontend/src/stores/session.ts`：值班管理员、调度员、设备专责、只读访客四种角色，
  页面右上角可切换演示；越权/越级当场拦截并指出还差哪一步；
  安装高度只允许本监测点的设备专责修改。
- 兼容既有记录：老数据缺片区/安装时间会在加载迁移时补齐，缺读数流水的记录沿用原状态与标记。

测试（纯函数域 + 服务层，不依赖浏览器）：

```bash
cd frontend
npm test
```

