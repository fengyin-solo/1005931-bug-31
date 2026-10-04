<template>
  <section class="page irr-page" data-module="irradiance">
    <header class="page-head">
      <div>
        <h2>辐照监测管理</h2>
        <p class="page-desc">
          监测点按安装时间登记；异常读数整笔判废、不进当日辐照量。校准一步写齐监测状态、当日辐照量与异常标记，写不成整笔退回；同一监测点连点两次只认头一回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出辐照监测清单</button>
        <button class="btn ghost" type="button" @click="restoreDemo">恢复演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">监测点总数</span>
        <strong class="stat-value">{{ pointStats.total }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-alert': pointStats.abnormal > 0 }">
        <span class="stat-label">数据异常点</span>
        <strong class="stat-value">{{ pointStats.abnormal }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待校准设备</span>
        <strong class="stat-value">{{ pointStats.pendingCalibration }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-alert': !report.matched }">
        <span class="stat-label">告警待处置台账（辐照异常）</span>
        <strong class="stat-value">{{ pointStats.unclosedAlarms }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in pointStats.byStatus" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item" :class="{ 'legend-bad': !report.matched }">
        两处数据异常点数对账：{{ report.ledgerCount }} / {{ report.pointCount }}
        <template v-if="report.matched">✓ 对得上</template>
        <template v-else>✗ 对不上（{{ report.diffs.join('；') }}）</template>
      </span>
    </p>

    <!-- 筛选：片区 + 关键字 + 按辐照量排序；翻页也不丢条件（同步到地址栏） -->
    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>片区</span>
        <select v-model="query.area" @change="goPage(1)">
          <option value="">全部片区</option>
          <option v-for="area in areas" :key="area" :value="area">{{ area }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>关键字（编号 / 名称 / 型号）</span>
        <input v-model="query.keyword" placeholder="按编号、名称或型号检索" @keydown.enter.prevent="goPage(1); reload()" />
      </label>
      <label class="filter-item">
        <span>排序</span>
        <select v-model="query.sort" @change="goPage(1)">
          <option value="installed">按安装时间（补齐后）</option>
          <option value="irradianceDesc">当日辐照量从高到低</option>
          <option value="irradianceAsc">当日辐照量从低到高</option>
        </select>
      </label>
      <label class="filter-item">
        <span>每页</span>
        <select v-model.number="query.size" @change="goPage(1)">
          <option :value="5">5 条</option>
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <span class="filter-sep">|</span>
      <label class="filter-item locate">
        <span>按编号直达</span>
        <input v-model="locateCode" placeholder="如 IRRA-0005" />
      </label>
      <button class="btn primary" type="button" @click="locatePoint">直接跳到它</button>
    </form>

    <table class="data-table irr-table">
      <thead>
        <tr>
          <th>监测点编号</th>
          <th>点位名称 / 片区</th>
          <th>设备格（型号·高度·专责）</th>
          <th class="num">当日辐照量 Wh/m²</th>
          <th>安装时间</th>
          <th>当前状态</th>
          <th>异常标记</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in page.items" :key="row.id" :class="{ 'row-selected': selectedId === row.id }">
          <td><button class="link" type="button" @click="selectPoint(row.id)">{{ row.code }}</button></td>
          <td>{{ row.name }}<br /><span class="cell-sub">{{ row.area }}</span></td>
          <td>
            <div class="device-cell">
              <span>{{ row.deviceModel }}</span>
              <span class="cell-sub">高度 {{ row.height }} m · 专责 {{ row.specialist }}</span>
              <span v-if="row.abnormalFlag" class="tag tag-bad">数据异常</span>
              <span v-else-if="row.pendingFlag" class="tag tag-wait">待校准</span>
              <span v-else class="tag tag-ok">监测正常</span>
            </div>
          </td>
          <td class="num">
            <template v-if="row.daily !== null">{{ row.daily }}</template>
            <span v-else class="cell-warn">全是坏值，无当日值</span>
            <div v-if="row.latestReading && row.latestReading.verdict === '无效'" class="cell-sub cell-warn">
              最新读数判废：{{ row.latestReading.reasons.join('；') }}
            </div>
          </td>
          <td>{{ row.installedAt }}</td>
          <td><span :class="['status-dot', `st-${row.status}`]">{{ row.status }}</span></td>
          <td>
            <span :class="['tag', row.abnormalFlag ? 'tag-bad' : 'tag-ok']">
              异常标记：{{ row.abnormalFlag ? '挂' : '清' }}
            </span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="doAction('anomaly', row)">登记异常</button>
            <button class="link" type="button" @click="doAction('arrange', row)">安排校准</button>
            <button class="link" type="button" @click="openCalibration(row)">执行校准</button>
            <button class="link" type="button" @click="doAction('recover', row)">确认恢复</button>
          </td>
        </tr>
        <tr v-if="!page.items.length">
          <td colspan="8" class="empty-state">{{ emptyHint }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ page.total }} 条，第 {{ page.page }} / {{ page.pages }} 页（筛选与排序已写进地址栏，翻页、来回跳转都不丢）</span>
      <span class="pager">
        <button class="btn" type="button" :disabled="page.page <= 1" @click="goPage(page.page - 1)">上一页</button>
        <button
          v-for="p in page.pages"
          :key="p"
          class="btn"
          :class="{ primary: p === page.page }"
          type="button"
          @click="goPage(p)"
        >{{ p }}</button>
        <button class="btn" type="button" :disabled="page.page >= page.pages" @click="goPage(page.page + 1)">下一页</button>
      </span>
    </footer>

    <p v-if="feedback" class="feedback" :class="feedback.ok ? 'fb-ok' : 'fb-err'">{{ feedback.text }}</p>

    <!-- 告警事件待处置台账：校准结论落在这；两边计数一致 -->
    <section class="panel">
      <h3>告警事件 · 辐照异常待处置台账（{{ ledger.length }} 条，与上方“数据异常点”口径对账）</h3>
      <table class="data-table mini">
        <thead>
          <tr><th>告警号</th><th>监测点</th><th>等级</th><th>发生/登记时间</th><th>事由</th><th>校准结论</th><th>点位现状</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="item.alarm.id">
            <td>{{ item.alarm.id }}</td>
            <td>{{ item.alarm.pointCode }}</td>
            <td>{{ item.alarm.level }}</td>
            <td>{{ item.alarm.openedAt }}</td>
            <td>{{ item.alarm.openedReason }}</td>
            <td>
              <template v-if="item.alarm.conclusion">
                <span class="tag tag-ok">{{ item.alarm.conclusion.result }}</span>
                系数 {{ item.alarm.conclusion.factor }}，{{ item.alarm.conclusion.operator }} @ {{ item.alarm.conclusion.at }}
                <div class="cell-sub">{{ item.alarm.conclusion.note }}</div>
              </template>
              <span v-else class="cell-sub">待执行校准后回填</span>
            </td>
            <td>{{ item.point.status }}</td>
            <td><button class="link" type="button" @click="doAction('recover', { id: item.point.id } as PointRow)">确认恢复出队</button></td>
          </tr>
          <tr v-if="!ledger.length"><td colspan="8" class="empty-state">待处置台账已清空，两处数据异常点数均为 0</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 待校准工单：同一点位只允许一条 -->
    <section class="panel">
      <h3>待校准工单（同一监测点重复安排只认头一张）</h3>
      <table class="data-table mini">
        <thead>
          <tr><th>工单号</th><th>监测点</th><th>派出时间</th><th>派单人</th><th>状态</th><th>校准结论</th></tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>{{ task.id }}</td>
            <td>{{ task.pointCode }}</td>
            <td>{{ task.orderedAt }}</td>
            <td>{{ task.orderedBy }}</td>
            <td>{{ task.status }}</td>
            <td>
              <template v-if="task.conclusion">
                {{ task.conclusion.result }}（系数 {{ task.conclusion.factor }}，{{ task.conclusion.operator }} @ {{ task.conclusion.at }}）
              </template>
              <span v-else class="cell-sub">待本点设备专责执行</span>
            </td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="6" class="empty-state">暂无待校准工单</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 详情面板：设备那格的异常标记、读数判废、安装高度修改都在这里 -->
    <section v-if="detail" class="panel detail-panel">
      <div class="panel-head">
        <h3>监测点详情 · {{ detail.code }}（{{ detail.area }}）</h3>
        <button class="btn ghost" type="button" @click="selectedId = null">收起</button>
      </div>
      <div class="detail-grid">
        <div class="detail-block">
          <h4>设备格</h4>
          <dl>
            <dt>设备型号</dt><dd>{{ detail.deviceModel }}</dd>
            <dt>设备专责</dt><dd>{{ detail.specialist }}</dd>
            <dt>安装高度</dt>
            <dd>
              <span v-if="!editingHeight">{{ detail.height }} m</span>
              <input v-else v-model.number="heightDraft" type="number" step="0.01" min="0" max="20" />
              <button v-if="!editingHeight" class="link" type="button" @click="startEditHeight">改高度</button>
              <template v-else>
                <button class="link" type="button" @click="saveHeight">保存</button>
                <button class="link" type="button" @click="editingHeight = false">取消</button>
              </template>
              <span class="cell-sub">（只有本监测点设备专责 {{ detail.specialist }} 能改）</span>
            </dd>
            <dt>安装时间</dt><dd>{{ detail.installedAt }}</dd>
            <dt>设备标记</dt>
            <dd>
              <span v-if="detail.abnormalFlag" class="tag tag-bad">设备数据异常</span>
              <span v-else class="tag tag-ok">设备数据正常</span>
            </dd>
            <dt>当日辐照量</dt>
            <dd>
              <strong>{{ detail.daily ?? '—' }}</strong> Wh/m²
              <span class="cell-sub">（只按当日有效读数算，坏值剔除）</span>
            </dd>
          </dl>
        </div>

        <div class="detail-block">
          <h4>当日读数（改线后已录读数照新线重过）</h4>
          <table class="data-table mini">
            <thead>
              <tr><th>时间</th><th>辐照量</th><th>峰值</th><th>组件℃</th><th>环境℃</th><th>判定</th></tr>
            </thead>
            <tbody>
              <tr v-for="reading in detailReadings" :key="reading.id">
                <td>{{ reading.ts.slice(11) }}</td>
                <td :class="{ 'cell-warn': reading.verdict === '无效' }">{{ reading.irradiation ?? '缺测' }}</td>
                <td>{{ reading.peak ?? '缺测' }}</td>
                <td :class="{ 'cell-warn': reading.verdict === '无效' }">{{ reading.moduleTemp ?? '缺测' }}</td>
                <td>{{ reading.ambientTemp ?? '缺测' }}</td>
                <td>
                  <span :class="['tag', reading.verdict === '有效' ? 'tag-ok' : 'tag-bad']">{{ reading.verdict }}</span>
                  <div v-if="reading.reasons.length" class="cell-sub cell-warn">{{ reading.reasons.join('；') }}（v{{ reading.ruleVersion }}）</div>
                </td>
              </tr>
              <tr v-if="!detailReadings.length"><td colspan="6" class="empty-state">当日暂无读数</td></tr>
            </tbody>
          </table>

          <form class="inline-form" @submit.prevent="submitReading">
            <h4>补录一笔读数</h4>
            <div class="form-line">
              <label>辐照量<input v-model.number="readingForm.irradiation" type="number" placeholder="Wh/m²" /></label>
              <label>峰值<input v-model.number="readingForm.peak" type="number" placeholder="W/m²" /></label>
              <label>组件℃<input v-model.number="readingForm.moduleTemp" type="number" /></label>
              <label>环境℃<input v-model.number="readingForm.ambientTemp" type="number" /></label>
              <button class="btn primary" type="submit">录入判定</button>
            </div>
          </form>
        </div>
      </div>
    </section>

    <!-- 判废线：管理员权衡；既有读数照新线重过 -->
    <section class="panel">
      <div class="panel-head">
        <h3>异常判废线（v{{ rules.version }}，{{ rules.updatedAt }} 由 {{ rules.updatedBy }} 调整）</h3>
        <button class="btn" type="button" :disabled="role.key !== 'admin'" @click="editingRules = !editingRules">
          {{ editingRules ? '收起改线' : '调整判废线' }}
        </button>
      </div>
      <p class="cell-sub">口径：{{ rulesText }}。任一格缺测或越线，整笔读数判废。改线后已录读数全部照新线重过一遍，点位异常状态与告警台账联动重算。</p>
      <form v-if="editingRules" class="rules-form" @submit.prevent="saveRules">
        <div v-for="item in ruleFields" :key="item.key" class="form-line">
          <label>{{ item.label }} 下限<input v-model.number="rulesDraft[item.key][0]" type="number" /></label>
          <label>{{ item.label }} 上限<input v-model.number="rulesDraft[item.key][1]" type="number" /></label>
        </div>
        <button class="btn primary" type="submit">保存并把已录读数重过一遍</button>
        <span v-if="role.key !== 'admin'" class="cell-warn">只有管理员能改线</span>
      </form>
    </section>

    <!-- 执行校准弹窗 -->
    <div v-if="calibrationTarget" class="modal-mask" @click.self="calibrationTarget = null">
      <div class="modal">
        <h3>执行校准 · {{ calibrationTarget.code }}</h3>
        <p class="cell-sub">
          本点专责 {{ calibrationTarget.specialist }} 执行。一步写齐：监测状态归位「监测中」、当日辐照量按系数重算、异常标记清除、校准结论写入告警待处置台账；任一步写不成就整笔退回。
        </p>
        <label class="modal-line">校准结论
          <select v-model="calibrationForm.result">
            <option value="合格">合格</option>
            <option value="修正系数">修正系数</option>
            <option value="更换探头">更换探头</option>
          </select>
        </label>
        <label class="modal-line">校准系数（合格固定为 1）
          <input v-model.number="calibrationForm.factor" type="number" step="0.001" min="0.001" max="2" :disabled="calibrationForm.result === '合格'" />
        </label>
        <label class="modal-line">校准说明
          <textarea v-model="calibrationForm.note" rows="3" placeholder="标准源比对偏差、调整方式等"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="calibrationSubmitting" @click="submitCalibration">
            {{ calibrationSubmitting ? '提交中…' : '提交校准（整笔写入）' }}
          </button>
          <button class="btn ghost" type="button" :disabled="calibrationSubmitting" @click="calibrationTarget = null">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useSessionStore } from '@/stores/session'
import {
  addReading,
  arrangeCalibration,
  consistency,
  currentRules,
  downloadCsv,
  editHeight,
  executeCalibration,
  listAreas,
  listPoints,
  listTasks,
  locatePoint as locatePointService,
  pendingLedger,
  readingsOf,
  recoverAlarm,
  registerAnomaly,
  resetDemo,
  stats,
  updateRules,
  type RulesInput,
} from '@/data/irradiance/service'
import type {
  AnomalyRules,
  CalibrationResult,
  CalibrationTask,
  PointRow,
  Reading,
  Role,
} from '@/data/irradiance/types'

const store = useSessionStore()
const role = computed<Role>(() => store.role)
const route = useRoute()
const router = useRouter()

const areas = ref<string[]>([])
const page = ref<ReturnType<typeof listPoints>>({ items: [], total: 0, page: 1, size: 5, pages: 1 })
const pointStats = ref(stats())
const report = ref(consistency())
const tasks = ref<CalibrationTask[]>(listTasks())
const ledger = ref(pendingLedger())

const query = reactive({
  keyword: '',
  area: '',
  sort: 'installed' as 'installed' | 'irradianceAsc' | 'irradianceDesc',
  page: 1,
  size: 5,
})
const locateCode = ref('')
const feedback = ref<{ ok: boolean; text: string } | null>(null)
const selectedId = ref<number | null>(null)

const rules = ref<AnomalyRules>(currentRules())
const editingRules = ref(false)
const rulesDraft = reactive({
  irradiation: [0, 0] as [number, number],
  peak: [0, 0] as [number, number],
  moduleTemp: [0, 0] as [number, number],
  ambientTemp: [0, 0] as [number, number],
})
const ruleFields = [
  { key: 'irradiation' as const, label: '当日辐照量 Wh/m²' },
  { key: 'peak' as const, label: '峰值辐照 W/m²' },
  { key: 'moduleTemp' as const, label: '组件温度 ℃' },
  { key: 'ambientTemp' as const, label: '环境温度 ℃' },
]
const rulesText = computed(() =>
  ruleFields
    .map((item) => `${item.label} ${rules.value[item.key][0]}~${rules.value[item.key][1]}`)
    .join('；'),
)

const calibrationTarget = ref<PointRow | null>(null)
const calibrationSubmitting = ref(false)
const calibrationForm = reactive<{ result: CalibrationResult; factor: number; note: string }>({
  result: '合格',
  factor: 1,
  note: '',
})

const editingHeight = ref(false)
const heightDraft = ref(0)
const readingForm = reactive({ irradiation: null as number | null, peak: null as number | null, moduleTemp: null as number | null, ambientTemp: null as number | null })

function say(ok: boolean, text: string) {
  feedback.value = { ok, text }
}

function refreshAll() {
  page.value = listPoints(query)
  pointStats.value = stats()
  report.value = consistency()
  areas.value = listAreas()
  tasks.value = listTasks()
  ledger.value = pendingLedger()
  rules.value = currentRules()
}

function reload() {
  feedback.value = null
  refreshAll()
}

function syncRoute() {
  const params: Record<string, string> = {}
  if (query.area) params.area = query.area
  if (query.keyword) params.keyword = query.keyword
  if (query.sort !== 'installed') params.sort = query.sort
  if (query.page !== 1) params.p = String(query.page)
  if (query.size !== 5) params.size = String(query.size)
  router.replace({ path: '/irradiance', query: params })
}

function readRoute() {
  query.area = String(route.query.area ?? '')
  query.keyword = String(route.query.keyword ?? '')
  query.sort = (String(route.query.sort ?? 'installed') as typeof query.sort)
  query.page = Number(route.query.p ?? 1) || 1
  query.size = Number(route.query.size ?? 5) || 5
}

function goPage(p: number) {
  query.page = p
  syncRoute()
  reload()
}

function resetFilters() {
  query.keyword = ''
  query.area = ''
  query.sort = 'installed'
  query.page = 1
  query.size = 5
  syncRoute()
  reload()
}

function locatePoint() {
  const code = locateCode.value.trim()
  if (!code) {
    say(false, '请填要直达的监测点编号')
    return
  }
  const result = locatePointService(code)
  if (!result.found || !result.query) {
    say(false, result.message)
    return
  }
  query.area = result.query.area
  query.keyword = result.query.keyword
  query.sort = result.query.sort
  query.page = result.query.page
  query.size = result.query.size
  syncRoute()
  reload()
  selectedId.value = page.value.items.find((item) => item.code === code.trim())?.id ?? selectedId.value
  say(true, result.message)
}

const emptyHint = computed(() => {
  const bits: string[] = []
  if (query.area) bits.push(`片区=${query.area}`)
  if (query.keyword) bits.push(`关键字=${query.keyword}`)
  return bits.length
    ? `当前条件（${bits.join('，')}）下没有监测点；可重置条件，或改用“按编号直达”逐格核对`
    : '暂无辐照监测数据'
})

// ── 行内动作 ────────────────────────────────────────────────────────────────

function doAction(kind: 'anomaly' | 'arrange' | 'recover', row: PointRow) {
  let result
  if (kind === 'anomaly') {
    const reason = window.prompt(`为 ${row.code} 登记异常的原因（可留空走默认口径）`, '')
    if (reason === null) return
    result = registerAnomaly(row.id, role.value, reason)
  } else if (kind === 'arrange') {
    result = arrangeCalibration(row.id, role.value)
  } else {
    const note = window.prompt(`确认 ${row.code} 告警恢复的处置说明（可留空）`, '')
    if (note === null) return
    result = recoverAlarm(row.id, role.value, note)
  }
  applyResult(result)
}

function applyResult(result: { ok: boolean; message: string }) {
  say(result.ok, result.message)
  refreshAll()
}

function openCalibration(row: PointRow) {
  calibrationTarget.value = row
  calibrationForm.result = '合格'
  calibrationForm.factor = 1
  calibrationForm.note = ''
}

watch(
  () => calibrationForm.result,
  (value) => {
    if (value === '合格') calibrationForm.factor = 1
  },
)

function submitCalibration() {
  if (!calibrationTarget.value || calibrationSubmitting.value) return
  calibrationSubmitting.value = true
  // 同一监测点连点两次：按钮在同一 tick 内就已禁用；服务层还有工单查重 + 提交锁双保险
  try {
    const result = executeCalibration(
      calibrationTarget.value.id,
      role.value,
      {
        result: calibrationForm.result,
        factor: calibrationForm.result === '合格' ? 1 : calibrationForm.factor,
        note: calibrationForm.note,
      },
    )
    calibrationTarget.value = null
    applyResult(result)
  } finally {
    calibrationSubmitting.value = false
  }
}

// ── 详情面板 ─────────────────────────────────────────────────────────────────

const detail = computed<PointRow | null>(() => {
  if (selectedId.value === null) return null
  return listPoints({ page: 1, size: 999 }).items.find((item) => item.id === selectedId.value) ?? null
})

const detailReadings = computed<Reading[]>(() => {
  if (!detail.value) return []
  return readingsOf(detail.value.code)
})

function selectPoint(id: number) {
  selectedId.value = id
}

function startEditHeight() {
  if (!detail.value) return
  heightDraft.value = detail.value.height
  editingHeight.value = true
}

function saveHeight() {
  if (!detail.value) return
  const result = editHeight(detail.value.id, role.value, heightDraft.value)
  editingHeight.value = false
  applyResult(result)
}

function submitReading() {
  if (!detail.value) return
  const norm = (value: number | null) =>
    value === null || Number.isNaN(Number(value)) ? null : Number(value)
  const result = addReading(detail.value.id, role.value, {
    irradiation: norm(readingForm.irradiation),
    peak: norm(readingForm.peak),
    moduleTemp: norm(readingForm.moduleTemp),
    ambientTemp: norm(readingForm.ambientTemp),
  })
  readingForm.irradiation = null
  readingForm.peak = null
  readingForm.moduleTemp = null
  readingForm.ambientTemp = null
  applyResult(result)
}

// ── 判废线 ─────────────────────────────────────────────────────────────────

function openRulesEditor() {
  for (const item of ruleFields) {
    rulesDraft[item.key] = [...rules.value[item.key]]
  }
}
watch(editingRules, (value) => {
  if (value) openRulesEditor()
})

function saveRules() {
  const input: RulesInput = {
    irradiation: rulesDraft.irradiation,
    peak: rulesDraft.peak,
    moduleTemp: rulesDraft.moduleTemp,
    ambientTemp: rulesDraft.ambientTemp,
  }
  const result = updateRules(role.value, input)
  applyResult(result)
  if (result.ok) editingRules.value = false
}

function exportRows() {
  downloadCsv()
}

function restoreDemo() {
  const result = resetDemo()
  applyResult(result)
}

// 初始化：先从地址栏恢复筛选条件（翻页/跳转不丢），再读数据
readRoute()
refreshAll()
if (editingRules.value) openRulesEditor()

watch(
  () => route.query,
  () => {
    // 浏览器前进后退时跟着恢复条件
    readRoute()
    reload()
  },
)
</script>
