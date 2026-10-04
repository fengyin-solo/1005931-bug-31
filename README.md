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

## 辐照监测领域（独立数据层）

辐照监测（`irradiance`）已经从通用台账里独立出来，领域代码在 `frontend/src/data/irradiance/`：

```text
types.ts    领域模型（监测点 / 读数 / 校准工单 / 待处置告警台账 / 判废线）
rules.ts    四格判废线（当日辐照量、峰值、组件温度、环境温度），任一格缺测或越线整笔读数判废
storage.ts  localStorage 持久化、整笔事务（写不成整笔退回）、校准幂等锁、老数据迁移与安装时间补齐
roles.ts    角色与越权口径（管理员改线、调度派单/确认恢复、设备专责执行校准）
service.ts  登记异常 / 安排校准 / 执行校准 / 确认恢复 / 改高度 / 补录读数 / 改线重算 / 台账对账
seed.ts     演示数据（东/南/西/北片区、各状态点位、含坏值读数、待处置告警）
```

关键口径：

- **当日辐照量**只取当日「有效」读数，坏值（缺测或越线）一律不参与。
- **校准收成一步**：监测状态归位、当日辐照量按校准系数重算、异常/待处置两条标记清除、
  校准结论写入告警事件待处置台账——同一笔事务，任一步写不成就整笔退回。
- **同一监测点连点两次校准只认头一回**：服务层有工单查重 + 提交锁，提交按钮在提交期间禁用。
- **状态机拦截**：已在待校准的点位不许再记异常；越级操作当场拦并指出还差哪一步
  （如「先安排校准」「由本点设备专责执行校准」），拦截同时把挂歪的两条标记按状态清齐。
- **安装高度只有本监测点的设备专责能改**；判废线只有管理员能改。
- **改判废线后已录的读数照新线逐笔重过**，点位异常状态与告警台账联动重算。
- **两处数据异常点数对账**：告警待处置台账条数 = 未闭环异常点数，每笔写操作都跑台账对账，
  页面上实时显示是否一致。
- **筛选不丢条件**：片区筛选 + 按当日辐照量排序 + 编号直达；条件同步到地址栏，翻页与来回跳转都不丢。
  找不到点位时逐格指出是编号、名称、型号还是片区对不上。
- **兼容既有监测点记录**：老通用台账里的辐照记录首次加载时整体迁入领域库（读数照判废线过一遍、
  缺安装时间的按顺序按月补齐），迁移后从通用台账摘走。

角色可在页面右上角切换（管理员 / 值班调度员 / 王建国 / 李卫国 / 外协访客），方便当场验证越权拦截。

### 领域逻辑冒烟脚本

```bash
cd frontend
# 需要 esbuild（npm install 后即有）；跨平台 node_modules 时补装对应平台的 @esbuild 包
node -e "require('esbuild').build({entryPoints:['smoke.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist-smoke/smoke.mjs',alias:{'@':require('path').resolve('src')}})"
node dist-smoke/smoke.mjs        # 42 项断言：事务、幂等、越权越级、改线重算、对账、筛选
node -e "require('esbuild').build({entryPoints:['smoke-migrate.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist-smoke/migrate.mjs',alias:{'@':require('path').resolve('src')}})"
node dist-smoke/migrate.mjs      # 老数据迁移与安装时间补齐
```

