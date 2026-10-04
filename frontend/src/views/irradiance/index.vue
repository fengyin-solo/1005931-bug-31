<template>
  <section class="page" data-module="irradiance">
    <header class="page-head">
      <div>
        <h2>辐照监测管理</h2>
        <p class="page-desc">
          维护辐照监测点的监测状态、当日辐照量与异常标记；校准一步提交（点位、辐照量、台账整笔成功或整笔退回），连点只认头一回。
        </p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          <span>当前角色</span>
          <select :value="store.role" @change="switchRole(($event.target as HTMLSelectElement).value as RoleKey)">
            <option v-for="role in ROLE_OPTIONS" :key="role.key" :value="role.key">{{ role.name }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="replayReadings">按新线重放已录读数</button>
        <button class="btn" type="button" @click="exportRows">导出辐照监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
        <small v-if="item.hint" class="stat-hint">{{ item.hint }}</small>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item ledger-legend">待处置校准台账：{{ ledgerOpen }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="submitQuery">
      <label class="filter-item">
        <span>所属片区</span>
        <select v-model="draftZone">
          <option value="">全部片区</option>
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>监测状态</span>
        <select v-model="draftStatus">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>关键词</span>
        <input v-model="draftKeyword" placeholder="编号 / 型号 / 片区 / 异常原因" />
      </label>
      <label class="filter-item">
        <span>排序</span>
        <span class="sort-line">
          <select v-model="draftSortKey">
            <option value="安装时间">按安装时间</option>
            <option value="当日辐照量">按当日辐照量</option>
            <option value="监测点编号">按监测点编号</option>
          </select>
          <button class="btn tiny" type="button" @click="toggleOrder">{{ draftSortOrder === 'asc' ? '升序 ↑' : '降序 ↓' }}</button>
        </span>
      </label>
      <label class="filter-item locate-item">
        <span>定位点位</span>
        <span class="sort-line">
          <input v-model="locateCode" placeholder="输入编号直达，如 IRRA-0004" />
          <button class="btn primary tiny" type="button" @click="locatePointRow">跳到它</button>
        </span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>监测状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in page.views" :key="String(row.id)" :class="{ 'row-hit': row.id === highlightId }">
          <td>
            <button class="link" type="button" @click="openDetail(row)">{{ row.code }}</button>
          </td>
          <td>{{ row.zone }}</td>
          <td>{{ row.model }}</td>
          <td>{{ row.height }} m</td>
          <td>{{ row.installedAt }}</td>
          <td>
            <template v-if="row.daily === null">
              <span class="bad-value">数据异常·不计入</span>
            </template>
            <template v-else>{{ row.daily.toLocaleString() }} Wh/m²</template>
          </td>
          <td>{{ row.peak === null ? '—' : `${row.peak} W/m²` }}</td>
          <td>{{ row.moduleTemp === null ? '—' : `${row.moduleTemp} ℃` }}</td>
          <td>{{ row.ambientTemp === null ? '—' : `${row.ambientTemp} ℃` }}</td>
          <td>
            <span class="status-tag" :class="statusClass(row)">{{ row.status }}</span>
            <span v-if="row.abnormal" class="abnormal-flag">设备格：数据异常</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="busyId === row.id" @click="runAction('登记异常', row)">登记异常</button>
            <button class="link" type="button" :disabled="busyId === row.id" @click="runAction('安排校准', row)">安排校准</button>
            <button class="link" type="button" :disabled="busyId === row.id" @click="openRecover(row)">确认恢复</button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!page.views.length">
          <td :colspan="columns.length + 2" class="empty-state">当前条件下没有辐照监测点，换个片区或重置条件试试</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot table-foot">
      <span>共 {{ page.total }} 条监测点，第 {{ page.page }} / {{ page.totalPages }} 页（条件翻页不丢）</span>
      <span class="pager">
        <button class="btn tiny" type="button" :disabled="page.page <= 1" @click="goPage(page.page - 1)">上一页</button>
        <button
          v-for="num in pageNumbers"
          :key="num"
          class="btn tiny"
          :class="{ primary: num === page.page }"
          type="button"
          @click="goPage(num)"
        >
          {{ num }}
        </button>
        <button class="btn tiny" type="button" :disabled="page.page >= page.totalPages" @click="goPage(page.page + 1)">下一页</button>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 详情面板：设备格异常标记、历史读数、安装高度修改都在这一格 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-panel detail-panel">
        <header class="modal-head">
          <h3>{{ detail.code }} 监测点详情</h3>
          <button class="btn tiny" type="button" @click="closeDetail">关闭</button>
        </header>
        <div class="detail-body">
          <div class="detail-grid">
            <span>所属片区</span><strong>{{ detail.zone }}</strong>
            <span>设备型号</span><strong>{{ detail.model }}</strong>
            <span>安装时间</span><strong>{{ detail.installedAt }}</strong>
            <span>安装高度</span>
            <strong class="height-cell">
              {{ detail.height }} m
              <button class="link tiny-link" type="button" @click="startEditHeight">{{ store.ownsPoint(detail.code) ? '修改' : '仅本点专责可改' }}</button>
            </strong>
            <span>监测状态</span>
            <strong>
              <span class="status-tag" :class="statusClass(detail)">{{ detail.status }}</span>
              <span v-if="detail.abnormal" class="abnormal-flag">设备格：数据异常</span>
            </strong>
            <span>当日辐照量</span>
            <strong>
              <template v-if="detail.daily === null"><span class="bad-value">数据异常·按坏值不统计</span></template>
              <template v-else>{{ detail.daily.toLocaleString() }} Wh/m²</template>
            </strong>
          </div>
          <p v-if="detail.reasons.length" class="reasons-box">
            坏值判据命中：{{ detail.reasons.join('；') }}
          </p>
          <h4>已录读数（改线后照新线重过）</h4>
          <table class="data-table reading-table">
            <thead>
              <tr><th>读数时间</th><th>当日辐照量</th><th>峰值辐照</th><th>组件温度</th><th>环境温度</th><th>判定线</th><th>判定结果</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in detailReadings" :key="item.at">
                <td>{{ item.at }}</td>
                <td>{{ item.daily === null ? '缺测' : item.daily }}</td>
                <td>{{ item.peak === null ? '缺测' : item.peak }}</td>
                <td>{{ item.moduleTemp === null ? '缺测' : `${item.moduleTemp} ℃` }}</td>
                <td>{{ item.ambientTemp === null ? '缺测' : `${item.ambientTemp} ℃` }}</td>
                <td>V{{ item.ruleVersion }}</td>
                <td>
                  <span v-if="item.reasons.length" class="bad-value">{{ item.reasons.join('；') }}</span>
                  <span v-else class="ok-text">合格</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 修改安装高度：只有本监测点设备专责可改 -->
    <div v-if="editingHeight" class="modal-mask" @click.self="cancelHeightEdit">
      <div class="modal-panel small-panel">
        <header class="modal-head">
          <h3>修改安装高度 · {{ editingHeight.code }}</h3>
          <button class="btn tiny" type="button" @click="cancelHeightEdit">关闭</button>
        </header>
        <div class="modal-body">
          <label class="filter-item">
            <span>安装高度（0.5 ~ 10 m）</span>
            <input v-model.number="heightDraft" type="number" step="0.01" min="0.5" max="10" />
          </label>
          <p v-if="!store.ownsPoint(editingHeight.code)" class="error-text">
            越级拦截：{{ store.operator }} 不是 {{ editingHeight.code }} 的设备专责，这一格只有本点专责能改
          </p>
          <p class="modal-tip">当前角色：{{ store.operator }}；名下点位：{{ store.responsibility.join('、') || '无' }}</p>
          <div class="modal-actions">
            <button class="btn primary" type="button" :disabled="!store.ownsPoint(editingHeight.code)" @click="submitHeight">保存高度</button>
            <button class="btn ghost" type="button" @click="cancelHeightEdit">取消</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 确认恢复 / 校准结论：一笔写入点位读数与待处置台账 -->
    <div v-if="recoverTarget" class="modal-mask" @click.self="cancelRecover">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>确认恢复 · {{ recoverTarget.code }} 校准结论</h3>
          <button class="btn tiny" type="button" @click="cancelRecover">关闭</button>
        </header>
        <div class="modal-body">
          <p class="modal-tip">
            校准读数与结论整笔提交：读数仍坏或台账落不下去都会整笔退回，点位状态保持「待校准」。
          </p>
          <div class="reading-form">
            <label class="filter-item">
              <span>当日辐照量 Wh/m²</span>
              <input v-model.number="recoverForm.daily" type="number" />
            </label>
            <label class="filter-item">
              <span>峰值辐照 W/m²</span>
              <input v-model.number="recoverForm.peak" type="number" />
            </label>
            <label class="filter-item">
              <span>组件温度 ℃</span>
              <input v-model.number="recoverForm.moduleTemp" type="number" />
            </label>
            <label class="filter-item">
              <span>环境温度 ℃</span>
              <input v-model.number="recoverForm.ambientTemp" type="number" />
            </label>
          </div>
          <label class="filter-item conclusion-box">
            <span>校准结论（写入待处置台账）</span>
            <textarea v-model="recoverConclusion" rows="2" placeholder="例：更换辐照探头并重新调平，示值与标准表偏差 0.8%"></textarea>
          </label>
          <div class="modal-actions">
            <button class="btn primary" type="button" :disabled="busyId === recoverTarget.id" @click="submitRecover">确认恢复并闭环台账</button>
            <button class="btn ghost" type="button" @click="cancelRecover">取消</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  changeHeight,
  locatePoint,
  queryIrradiance,
  recoverPoint,
  registerAbnormal,
  replayAllReadings,
  scheduleCalibration,
  type IrradianceSortKey,
  type PointView,
  type SortOrder,
} from '@/api/irradiance-service'
import { listCalibrationLedgers } from '@/api/ledger-service'
import { ROLE_OPTIONS, useSessionStore, type RoleKey } from '@/stores/session'
import type { EntryReading } from '@/data/types'
import { listRows } from '@/data/local-store'

const meta = moduleMeta('irradiance')
const store = useSessionStore()
const route = useRoute()
const router = useRouter()

const columns = [
  '监测点编号', '所属片区', '设备型号', '安装高度', '安装时间',
  '当日辐照量', '峰值辐照', '组件温度', '环境温度',
]
const statuses = ['监测中', '数据异常', '待校准', '已停用']

function routeString(key: string): string {
  const value = route.query[key]
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

const draftZone = ref(routeString('zone'))
const draftStatus = ref(routeString('status'))
const draftKeyword = ref(routeString('keyword'))
const draftSortKey = ref<IrradianceSortKey>(
  (routeString('sortKey') as IrradianceSortKey) || '安装时间',
)
const draftSortOrder = ref<SortOrder>(routeString('sortOrder') === 'desc' ? 'desc' : 'asc')
const locateCode = ref('')

const errorMessage = ref('')
const okMessage = ref('')
const busyId = ref<number | null>(null)
const highlightId = ref<number | null>(null)

const detail = ref<PointView | null>(null)
const detailReadings = ref<EntryReading[]>([])
const editingHeight = ref<PointView | null>(null)
const heightDraft = ref(1.5)
const recoverTarget = ref<PointView | null>(null)
const recoverConclusion = ref('')
const recoverForm = reactive({ daily: 5400, peak: 950, moduleTemp: 45, ambientTemp: 30 })

const appliedQuery = computed(() => ({
  filters: {
    zone: routeString('zone'),
    status: routeString('status'),
    keyword: routeString('keyword'),
  },
  sortKey: (routeString('sortKey') || '安装时间') as IrradianceSortKey,
  sortOrder: (routeString('sortOrder') || 'asc') as SortOrder,
  page: Number(routeString('page')) || 1,
}))

const page = ref(queryIrradiance(appliedQuery.value))
const zones = computed(() => page.value.zones)
const ledgerOpen = ref(0)
// 数据写在 localStorage 里，不是响应式数据；每次 reload 抬一下刻度，统计类 computed 跟着重算。
const refreshTick = ref(0)

const pageNumbers = computed(() => {
  const total = page.value.totalPages
  const current = page.value.page
  const nums: number[] = []
  const start = Math.max(1, Math.min(current - 2, total - 4))
  for (let n = start; n <= Math.min(total, start + 4); n += 1) nums.push(n)
  return nums
})

const stats = computed(() => {
  void refreshTick.value
  const rows = listRows('irradiance')
  const abnormal = rows.filter((row) => String(row.status) === '数据异常').length
  const calibrating = rows.filter((row) => String(row.status) === '待校准').length
  const validDailySum = rows.reduce((sum, row) => {
    const value = row['当日辐照量']
    return typeof value === 'number' && Number.isFinite(value) ? sum + value : sum
  }, 0)
  return [
    { label: '监测点总数', value: rows.length, hint: '按安装时间补齐在册' },
    { label: '数据异常点', value: abnormal, hint: `台账待处置 ${ledgerOpen.value} 条` },
    { label: '待校准设备', value: calibrating, hint: '' },
    { label: '有效当日辐照量合计', value: `${validDailySum.toLocaleString()} Wh/m²`, hint: '坏值不计入' },
  ]
})

const statusSummary = computed(() => {
  void refreshTick.value
  return statuses.map((status) => ({
    status,
    count: listRows('irradiance').filter((row) => String(row.status) === status).length,
  }))
})

function statusClass(row: PointView): string {  if (row.status === '数据异常') return 'is-abnormal'
  if (row.status === '待校准') return 'is-pending'
  if (row.status === '已停用') return 'is-stopped'
  return 'is-normal'
}

function reload() {
  page.value = queryIrradiance(appliedQuery.value)
  const { open } = listCalibrationLedgers()
  ledgerOpen.value = open.length
  refreshTick.value += 1
  if (detail.value) {
    const fresh = page.value.views.find((item) => item.id === detail.value?.id)
    if (fresh) detail.value = fresh
  }
}

function syncRoute(patch: Record<string, string | number>, resetPage = false) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (Array.isArray(value)) continue
    if (value !== undefined && value !== null && value !== '') query[key] = String(value)
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || value === undefined || value === null) delete query[key]
    else query[key] = String(value)
  }
  if (resetPage) delete query.page
  router.replace({ query })
}

watch(
  () => route.query,
  () => {
    draftZone.value = routeString('zone')
    draftStatus.value = routeString('status')
    draftKeyword.value = routeString('keyword')
    draftSortKey.value = (routeString('sortKey') || '安装时间') as IrradianceSortKey
    draftSortOrder.value = routeString('sortOrder') === 'desc' ? 'desc' : 'asc'
    reload()
  },
)

function submitQuery() {
  clearMessages()
  syncRoute(
    {
      zone: draftZone.value,
      status: draftStatus.value,
      keyword: draftKeyword.value,
      sortKey: draftSortKey.value,
      sortOrder: draftSortOrder.value,
    },
    true,
  )
}

function resetFilters() {
  draftZone.value = ''
  draftStatus.value = ''
  draftKeyword.value = ''
  draftSortKey.value = '安装时间'
  draftSortOrder.value = 'asc'
  router.replace({ query: {} })
  clearMessages()
}

function toggleOrder() {
  draftSortOrder.value = draftSortOrder.value === 'asc' ? 'desc' : 'asc'
}

function goPage(num: number) {
  highlightId.value = null
  syncRoute({ page: num })
}

function locatePointRow() {
  clearMessages()
  const result = locatePoint(locateCode.value, {
    filters: appliedQuery.value.filters,
    sortKey: appliedQuery.value.sortKey,
    sortOrder: appliedQuery.value.sortOrder,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  highlightId.value = result.view.id
  syncRoute({ page: result.page })
  okMessage.value = `已按当前排序跳到「${result.view.code}」所在第 ${result.page} 页（${result.view.zone} · ${result.view.status}）`
  locateCode.value = ''
}

function actor() {
  return {
    role: store.role,
    name: store.operator,
    owns: (code: string) => store.ownsPoint(code),
  }
}

function runAction(action: '登记异常' | '安排校准', row: PointView) {
  clearMessages()
  busyId.value = row.id
  try {
    if (action === '登记异常') {
      okMessage.value = registerAbnormal(row.id, actor())
    } else {
      okMessage.value = scheduleCalibration(row.id, actor())
    }
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `${action}失败，已整笔退回`
    reload()
  } finally {
    busyId.value = null
  }
}

function openRecover(row: PointView) {
  clearMessages()
  recoverTarget.value = row
  recoverConclusion.value = ''
  recoverForm.daily = row.daily ?? 5400
  recoverForm.peak = row.peak ?? 950
  recoverForm.moduleTemp = row.moduleTemp ?? 45
  recoverForm.ambientTemp = row.ambientTemp ?? 30
}

function submitRecover() {
  if (!recoverTarget.value) return
  const target = recoverTarget.value
  busyId.value = target.id
  try {
    okMessage.value = recoverPoint(
      target.id,
      actor(),
      {
        daily: recoverForm.daily,
        peak: recoverForm.peak,
        moduleTemp: recoverForm.moduleTemp,
        ambientTemp: recoverForm.ambientTemp,
      },
      recoverConclusion.value,
    )
    recoverTarget.value = null
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '确认恢复失败，已整笔退回'
  } finally {
    busyId.value = null
  }
}

function openDetail(row: PointView) {
  clearMessages()
  detail.value = row
  const source = listRows('irradiance').find((item) => Number(item.id) === row.id)
  detailReadings.value = Array.isArray(source?.readings)
    ? (source!.readings as EntryReading[]).slice().reverse()
    : []
}

function closeDetail() {
  detail.value = null
}

function startEditHeight() {
  if (!detail.value) return
  editingHeight.value = detail.value
  heightDraft.value = detail.value.height
}

function cancelHeightEdit() {
  editingHeight.value = null
}

function cancelRecover() {
  recoverTarget.value = null
}

function submitHeight() {
  if (!editingHeight.value) return
  try {
    okMessage.value = changeHeight(editingHeight.value.id, actor(), Number(heightDraft.value))
    editingHeight.value = null
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '安装高度修改被拦截'
  }
}

function replayReadings() {
  clearMessages()
  try {
    okMessage.value = replayAllReadings()
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读数重放失败'
  }
}

function switchRole(role: RoleKey) {
  store.setRole(role)
  clearMessages()
  okMessage.value = `已切换为「${store.operator}」${store.roleOption.canEditHeight ? '，可改本点位安装高度' : ''}`
}

function exportRows() {
  downloadEntries(meta.key)
}

function clearMessages() {
  errorMessage.value = ''
  okMessage.value = ''
}

onMounted(reload)
</script>
