<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>告警事件管理</h2>
        <p class="page-desc">辐照校准结论统一落到本页「待处置台账」；台账上的数据异常点数与辐照监测页实时对账，对不上整笔退回。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记告警事件</button>
        <button class="btn" type="button" @click="exportRows">导出告警事件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in ledgerStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-alert': item.alert }">{{ item.value }}</strong>
        <small v-if="item.hint" class="stat-hint">{{ item.hint }}</small>
      </article>
    </div>

    <h3 class="block-title">辐照校准待处置台账</h3>
    <p class="reconcile-line" :class="reconciled ? 'ok-text' : 'error-text'">
      {{ reconcileText }}
    </p>
    <table class="data-table ledger-table">
      <thead>
        <tr>
          <th>台账编号</th><th>告警等级</th><th>关联监测点</th><th>发生时间</th>
          <th>处置人员</th><th>台账状态</th><th>校准结论</th><th>闭环时间</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in openLedgers" :key="item.id">
          <td>{{ item.code }}</td>
          <td><span class="status-tag" :class="item.level === '严重' ? 'is-abnormal' : 'is-pending'">{{ item.level }}</span></td>
          <td>{{ item.pointCode }}</td>
          <td>{{ item.happenedAt }}</td>
          <td>{{ item.handler || '—' }}</td>
          <td><span class="status-tag" :class="item.status === '处理中' ? 'is-pending' : 'is-abnormal'">{{ item.status }}</span></td>
          <td>{{ item.conclusion || '待校准回填结论' }}</td>
          <td>—</td>
          <td class="row-actions">
            <button class="link" type="button" @click="claim(item.id)">认领处置</button>
          </td>
        </tr>
        <tr v-if="!openLedgers.length">
          <td colspan="9" class="empty-state">待处置台账已清空，辐照监测点均无未闭环校准事项</td>
        </tr>
      </tbody>
    </table>

    <details class="closed-ledger">
      <summary>已闭环校准台账（{{ closedLedgers.length }}）</summary>
      <table class="data-table ledger-table">
        <thead>
          <tr><th>台账编号</th><th>关联监测点</th><th>处置人员</th><th>校准结论</th><th>闭环时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in closedLedgers" :key="item.id">
            <td>{{ item.code }}</td>
            <td>{{ item.pointCode }}</td>
            <td>{{ item.handler || '—' }}</td>
            <td>{{ item.conclusion }}</td>
            <td>{{ item.closedAt }}</td>
          </tr>
          <tr v-if="!closedLedgers.length">
            <td colspan="5" class="empty-state">暂无已闭环台账</td>
          </tr>
        </tbody>
      </table>
    </details>

    <h3 class="block-title second-block">普通告警事件</h3>
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
        <tr v-for="row in genericRows" :key="String(row.id)">
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
        <tr v-if="!genericRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无普通告警事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ genericRows.length }} 条普通告警，台账口径只统计辐照校准事项</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  filterRows,
  listRowsSafe,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listCalibrationLedgers, startLedgerDisposal } from '@/api/ledger-service'
import { isLedger } from '@/data/ledger'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('alarm')
const store = useSessionStore()
const columns = ['告警编号', '告警等级', '告警来源', '发生时间', '持续时长', '关联设备', '处置人员', '告警状态']
const actions = ['确认告警', '登记恢复', '转缺陷单']

const genericRows = ref<EntryRow[]>([])
const openLedgers = ref<ReturnType<typeof listCalibrationLedgers>['open']>([])
const closedLedgers = ref<ReturnType<typeof listCalibrationLedgers>['closed']>([])
const counters = ref({ 数据异常点数: 0, 待校准点数: 0, 待处置台账: 0, 已闭环台账: 0 })
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const ledgerStats = computed(() => [
  {
    label: '数据异常点（辐照页口径）',
    value: counters.value.数据异常点数,
    hint: '',
    alert: counters.value.数据异常点数 > 0,
  },
  {
    label: '待校准设备（辐照页口径）',
    value: counters.value.待校准点数,
    hint: '',
    alert: counters.value.待校准点数 > 0,
  },
  {
    label: '待处置校准台账',
    value: counters.value.待处置台账,
    hint: `应等于前两项之和 ${counters.value.数据异常点数 + counters.value.待校准点数}`,
    alert: counters.value.待处置台账 !== counters.value.数据异常点数 + counters.value.待校准点数,
  },
  { label: '已闭环台账', value: counters.value.已闭环台账, hint: '', alert: false },
])

const reconciled = computed(
  () => counters.value.待处置台账 === counters.value.数据异常点数 + counters.value.待校准点数,
)
const reconcileText = computed(() =>
  reconciled.value
    ? `对账一致：数据异常 ${counters.value.数据异常点数} 点 + 待校准 ${counters.value.待校准点数} 点 = 待处置台账 ${counters.value.待处置台账} 条`
    : `对账失败：台账 ${counters.value.待处置台账} 条 ≠ 异常 ${counters.value.数据异常点数} + 待校准 ${counters.value.待校准点数}，事务应整笔退回`,
)

function reload() {
  errorMessage.value = ''
  try {
    const ledgerPayload = listCalibrationLedgers()
    openLedgers.value = ledgerPayload.open
    closedLedgers.value = ledgerPayload.closed
    counters.value = ledgerPayload.counters
    const allAlarms = listRowsSafe(meta.key)
    genericRows.value = filterRows(allAlarms.filter((row) => !isLedger(row)), filters.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '告警台账读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 校准台账不混进普通告警清单，台账口径在本页专区单独看。
  downloadEntries(meta.key, genericRows.value)
}

function openCreate() {
  errorMessage.value = '告警事件登记入口尚未接入审批流'
}

function claim(id: number) {
  errorMessage.value = ''
  try {
    startLedgerDisposal(id, store.operator)
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '认领失败'
  }
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

onMounted(reload)
</script>

<style scoped>
.block-title { font-size: 14px; margin: 16px 0 6px; }
.block-title.second-block { margin-top: 22px; }
.reconcile-line { margin: 0 0 8px; font-size: 12px; background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
.ledger-table th, .ledger-table td { font-size: 12px; }
.stat-alert { color: #b42318; }
.closed-ledger { margin-top: 10px; font-size: 12px; color: var(--muted); }
.closed-ledger summary { cursor: pointer; margin-bottom: 6px; }
</style>
