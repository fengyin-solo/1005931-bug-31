<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>告警事件管理</h2>
        <p class="page-desc">维护告警事件，围绕告警编号、告警等级、告警来源、发生时间做登记、筛选与状态流转；辐照监测点的校准结论统一落在下方待处置台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记告警事件</button>
        <button class="btn" type="button" @click="exportRows">导出告警事件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待确认告警</span>
        <strong class="stat-value">{{ genericStats.pending }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-alert': !irradianceReport.matched }">
        <span class="stat-label">辐照异常待处置（台账）</span>
        <strong class="stat-value">{{ irradianceLedger.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">辐照未闭环异常点（监测侧）</span>
        <strong class="stat-value">{{ irradianceReport.pointCount }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-ok': irradianceReport.matched }">
        <span class="stat-label">两处数据异常点数对账</span>
        <strong class="stat-value">{{ irradianceReport.matched ? '一致 ✓' : '不一致 ✗' }}</strong>
      </article>
    </div>

    <!-- 辐照异常待处置台账 -->
    <section class="panel">
      <h3>辐照异常待处置台账（校准结论落到这里，确认恢复才出队）</h3>
      <table class="data-table mini">
        <thead>
          <tr>
            <th>告警号</th><th>监测点</th><th>等级</th><th>登记时间</th><th>异常事由</th>
            <th>校准结论</th><th>点位现状</th><th>判废线</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in irradianceLedger" :key="item.alarm.id">
            <td>{{ item.alarm.id }}</td>
            <td>{{ item.alarm.pointCode }}</td>
            <td>
              <span :class="['tag', item.alarm.level === '一级' ? 'tag-bad' : 'tag-wait']">{{ item.alarm.level }}</span>
            </td>
            <td>{{ item.alarm.openedAt }}</td>
            <td>{{ item.alarm.openedReason }}</td>
            <td>
              <template v-if="item.alarm.conclusion">
                <span class="tag tag-ok">{{ item.alarm.conclusion.result }}</span>
                系数 {{ item.alarm.conclusion.factor }} · {{ item.alarm.conclusion.operator }}
                <div class="cell-sub">{{ item.alarm.conclusion.note }}</div>
              </template>
              <span v-else class="cell-sub">还没执行校准，结论待回填</span>
            </td>
            <td>{{ item.point.status }}</td>
            <td>v{{ item.alarm.ruleVersion }}</td>
            <td>
              <button class="link" type="button" @click="recover(item.point.id)">确认恢复（出队）</button>
            </td>
          </tr>
          <tr v-if="!irradianceLedger.length">
            <td colspan="9" class="empty-state">辐照异常待处置台账为空，两处数据异常点数都是 0</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!irradianceReport.matched" class="cell-warn">
        对账发现差异：{{ irradianceReport.diffs.join('；') }}
      </p>
      <p class="cell-sub">计数口径：台账条数 = 有待处置告警的辐照监测点数；每笔校准/恢复与台账写入是同一笔事务，保证两边对得上。</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无告警事件数据，可先登记告警事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条通用告警事件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import { consistency, pendingLedger, recoverAlarm } from '@/data/irradiance/service'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('alarm')
const columns = ["告警编号", "告警等级", "告警来源", "发生时间", "持续时长", "关联设备", "处置人员", "告警状态"]
const actions = ["确认告警", "登记恢复", "转缺陷单"]
const statuses = ["待确认", "处理中", "已恢复", "已转缺陷"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const irradianceLedger = ref(pendingLedger())
const irradianceReport = ref(consistency())
const genericStats = computed(() => ({
  pending: rows.value.filter((row) => row.pending).length,
}))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function refreshIrradiance() {
  irradianceLedger.value = pendingLedger()
  irradianceReport.value = consistency()
}

function recover(id: number) {
  const note = window.prompt('确认告警恢复的处置说明（可留空）', '')
  if (note === null) return
  const result = recoverAlarm(id, store.role, note)
  errorMessage.value = ''
  if (!result.ok) {
    errorMessage.value = result.message
  }
  refreshIrradiance()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '告警事件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshIrradiance()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '告警事件列表读取失败'
  }
}

onMounted(reload)
</script>
