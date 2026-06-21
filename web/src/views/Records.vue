<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore } from '../store/auth';
import { api } from '../api';
import { toCsv, toBind, simplify, parseImport } from '../dnsio';

const route = useRoute();

const store = useAppStore();

const accountId = ref(null);
const zones = ref([]);
const zoneId = ref(null);
const loadingZones = ref(false);

// All records for the selected zone are loaded once; filtering / searching /
// paginating happen client-side for instant, multi-field search.
const allRecords = ref([]);
const loadingRecords = ref(false);
const filterType = ref('');
const searchText = ref('');
const page = ref(1);
const perPage = ref(50);
const tableRef = ref(null);
const selectedRows = ref([]);

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];
const PROXYABLE = ['A', 'AAAA', 'CNAME'];
const PRIORITY_TYPES = ['MX', 'SRV'];
const TTL_OPTIONS = [
  { label: '自动', value: 1 },
  { label: '1 分钟', value: 60 },
  { label: '2 分钟', value: 120 },
  { label: '5 分钟', value: 300 },
  { label: '10 分钟', value: 600 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '1 天', value: 86400 },
];

const currentZone = computed(() => zones.value.find((z) => z.id === zoneId.value));

const filteredRecords = computed(() => {
  let list = allRecords.value;
  if (filterType.value) list = list.filter((r) => r.type === filterType.value);
  const q = searchText.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.content || '').toLowerCase().includes(q) ||
        (r.comment || '').toLowerCase().includes(q),
    );
  }
  return list;
});
const pagedRecords = computed(() => {
  const start = (page.value - 1) * perPage.value;
  return filteredRecords.value.slice(start, start + perPage.value);
});

const selectedIds = computed(() => selectedRows.value.map((r) => r.id));
const selectedAllProxyable = computed(
  () => selectedRows.value.length > 0 && selectedRows.value.every((r) => PROXYABLE.includes(r.type)),
);

function clearSelection() {
  selectedRows.value = [];
  tableRef.value?.clearSelection?.();
}
watch([filterType, searchText], () => {
  page.value = 1;
  clearSelection();
});

onMounted(async () => {
  try {
    await store.loadAccounts();
    if (!store.accounts.length) return;
    // Preselect account/zone when arriving from global search (?accountId=&zoneId=).
    const qAccount = Number(route.query.accountId);
    accountId.value = store.accounts.some((a) => a.id === qAccount) ? qAccount : store.accounts[0].id;
    await loadZones();
    const qZone = route.query.zoneId;
    if (qZone && zoneId.value !== qZone && zones.value.some((z) => z.id === qZone)) {
      zoneId.value = qZone;
      await loadAllRecords();
    }
  } catch (e) {
    ElMessage.error(e.message);
  }
});

async function loadZones() {
  zones.value = [];
  zoneId.value = null;
  allRecords.value = [];
  if (!accountId.value) return;
  loadingZones.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/zones`);
    zones.value = r.zones;
    if (zones.value.length === 1) {
      zoneId.value = zones.value[0].id;
      await loadAllRecords();
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingZones.value = false;
  }
}

async function loadAllRecords() {
  clearSelection();
  if (!zoneId.value) {
    allRecords.value = [];
    return;
  }
  loadingRecords.value = true;
  try {
    const r = await api.get(`api/zones/${zoneId.value}/export`, { accountId: accountId.value });
    allRecords.value = r.records || [];
    page.value = 1;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingRecords.value = false;
  }
}

function onZoneChange() {
  loadAllRecords();
}
function onPageChange(p) {
  page.value = p;
  clearSelection();
}

/* ---- create / edit dialog ---- */
const dialogVisible = ref(false);
const editingId = ref(null);
const form = reactive({
  type: 'A',
  name: '',
  content: '',
  ttl: 1,
  proxied: false,
  priority: 10,
  comment: '',
});
const saving = ref(false);

const isProxyable = computed(() => PROXYABLE.includes(form.type));
const hasPriority = computed(() => PRIORITY_TYPES.includes(form.type));

function resetForm(values) {
  Object.assign(
    form,
    { type: 'A', name: '', content: '', ttl: 1, proxied: false, priority: 10, comment: '' },
    values,
  );
}

function openCreate() {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

// Show only the subdomain (relative) part in the form; the zone suffix is the
// input's append hint, so the full name isn't displayed twice. The root record
// shows as "@". The backend's toFqdn re-qualifies on save.
function toRelativeName(fullName) {
  const zone = currentZone.value?.name;
  if (!zone || !fullName) return fullName || '';
  if (fullName === zone) return '@';
  const suffix = '.' + zone;
  return fullName.endsWith(suffix) ? fullName.slice(0, -suffix.length) : fullName;
}

function openEdit(row) {
  editingId.value = row.id;
  resetForm({
    type: row.type,
    name: toRelativeName(row.name),
    content: row.content,
    ttl: row.ttl,
    proxied: !!row.proxied,
    priority: row.priority ?? 10,
    comment: row.comment || '',
  });
  dialogVisible.value = true;
}

async function save() {
  if (!form.name || !form.content) return ElMessage.warning('名称与内容必填');
  const record = {
    type: form.type,
    name: form.name.trim(),
    content: form.content.trim(),
    ttl: isProxyable.value && form.proxied ? 1 : form.ttl,
    proxied: isProxyable.value ? form.proxied : undefined,
    priority: hasPriority.value ? Number(form.priority) : undefined,
    comment: form.comment || undefined,
  };
  const payload = { accountId: accountId.value, zoneName: currentZone.value?.name, record };
  saving.value = true;
  try {
    if (editingId.value) {
      await api.put(`api/zones/${zoneId.value}/records/${editingId.value}`, payload);
      ElMessage.success('已更新');
    } else {
      await api.post(`api/zones/${zoneId.value}/records`, payload);
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确认删除记录 ${row.type}  ${row.name} ?`, '删除确认', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await api.del(`api/zones/${zoneId.value}/records/${row.id}`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      rrType: row.type,
      rrName: row.name,
    });
    ElMessage.success('已删除');
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/* ---- bulk operations (act on the current selection) ---- */
function onSelectionChange(rows) {
  selectedRows.value = rows;
}

async function bulkDelete() {
  const ids = selectedIds.value;
  if (!ids.length) return;
  try {
    await ElMessageBox.confirm(`确认删除选中的 ${ids.length} 条记录?`, '批量删除', { type: 'warning' });
  } catch {
    return;
  }
  try {
    const res = await api.post(`api/zones/${zoneId.value}/records/bulk-delete`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      ids,
    });
    ElMessage.success(`已删除 ${res.deleted} 条${res.failed ? `,失败 ${res.failed}` : ''}`);
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

const bulkTtlVisible = ref(false);
const bulkTtl = ref(1);
function openBulkTtl() {
  if (!selectedIds.value.length) return;
  bulkTtl.value = 1;
  bulkTtlVisible.value = true;
}
async function applyBulkTtl() {
  try {
    const res = await api.post(`api/zones/${zoneId.value}/records/bulk-patch`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      ids: selectedIds.value,
      patch: { ttl: bulkTtl.value },
    });
    ElMessage.success(`已修改 TTL ${res.updated} 条${res.failed ? `,失败 ${res.failed}` : ''}`);
    bulkTtlVisible.value = false;
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
async function bulkProxied(on) {
  if (!selectedAllProxyable.value) return ElMessage.warning('代理仅适用于 A/AAAA/CNAME');
  try {
    await ElMessageBox.confirm(
      `将选中的 ${selectedIds.value.length} 条记录${on ? '开启' : '关闭'}代理(橙云)?`,
      '批量代理',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    const res = await api.post(`api/zones/${zoneId.value}/records/bulk-patch`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      ids: selectedIds.value,
      patch: { proxied: on },
    });
    ElMessage.success(`已${on ? '开启' : '关闭'}代理 ${res.updated} 条${res.failed ? `,失败 ${res.failed}` : ''}`);
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/* ---- export ---- */
async function exportRecords(format) {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  try {
    const recs = allRecords.value.map(simplify);
    const zone = currentZone.value?.name || 'zone';
    if (format === 'json') {
      downloadFile(`${zone}-dns.json`, JSON.stringify(recs, null, 2), 'application/json');
    } else if (format === 'bind') {
      downloadFile(`${zone}.txt`, toBind(recs, zone), 'text/plain;charset=utf-8');
    } else {
      downloadFile(`${zone}-dns.csv`, toCsv(recs), 'text/csv;charset=utf-8');
    }
    ElMessage.success(`已导出 ${recs.length} 条记录`);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function downloadFile(filename, content, mime) {
  const prefix = mime.startsWith('text/csv') ? '﻿' : ''; // BOM so Excel reads UTF-8
  const blob = new Blob([prefix + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---- import ---- */
const importVisible = ref(false);
const importText = ref('');
const importRecords = ref([]);
const importParseError = ref('');
const importing = ref(false);
const previewing = ref(false);
const importResult = ref(null);
const importPreview = ref(null);
const deleteMissing = ref(false);
const fileInput = ref(null);

function openImport() {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  importText.value = '';
  importRecords.value = [];
  importParseError.value = '';
  importResult.value = null;
  importPreview.value = null;
  deleteMissing.value = false;
  importVisible.value = true;
}

function onImportTextChange() {
  importResult.value = null;
  importPreview.value = null;
  try {
    importRecords.value = parseImport(importText.value);
    importParseError.value = '';
  } catch (e) {
    importRecords.value = [];
    importParseError.value = e.message || '解析失败';
  }
}

function pickFile() {
  fileInput.value?.click();
}

function onFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result || '');
    onImportTextChange();
  };
  reader.readAsText(file);
  ev.target.value = '';
}

async function doPreview() {
  if (!importRecords.value.length) return;
  previewing.value = true;
  try {
    importPreview.value = await api.post(`api/zones/${zoneId.value}/import`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      records: importRecords.value,
      dryRun: true,
      deleteMissing: deleteMissing.value,
    });
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    previewing.value = false;
  }
}

async function doImport() {
  if (!importRecords.value.length) return;
  const delNote = deleteMissing.value ? ',并删除文件中没有的记录(完全同步)' : '';
  try {
    await ElMessageBox.confirm(
      `将导入 ${importRecords.value.length} 条记录到 ${currentZone.value?.name},同名同类型覆盖更新${delNote}。确定继续?`,
      '确认导入',
      { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  importing.value = true;
  try {
    const res = await api.post(`api/zones/${zoneId.value}/import`, {
      accountId: accountId.value,
      zoneName: currentZone.value?.name,
      records: importRecords.value,
      deleteMissing: deleteMissing.value,
    });
    importResult.value = res;
    importPreview.value = null;
    ElMessage.success(
      `导入完成:新增 ${res.created}、覆盖 ${res.updated}、删除 ${res.deleted || 0}、失败 ${res.failed}`,
    );
    await loadAllRecords();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="toolbar">
    <el-select v-model="accountId" placeholder="选择账号" style="width: 170px" @change="loadZones">
      <el-option
        v-for="a in store.accounts"
        :key="a.id"
        :label="`${a.label} (····${a.token_last4})`"
        :value="a.id"
      />
    </el-select>

    <el-select
      v-model="zoneId"
      placeholder="选择域名"
      filterable
      style="width: 240px"
      :loading="loadingZones"
      @change="onZoneChange"
    >
      <el-option v-for="z in zones" :key="z.id" :label="z.name" :value="z.id" />
    </el-select>

    <el-select v-model="filterType" placeholder="类型" clearable style="width: 110px">
      <el-option v-for="t in RECORD_TYPES" :key="t" :label="t" :value="t" />
    </el-select>

    <el-input
      v-model="searchText"
      placeholder="搜索 名称 / 内容 / 备注"
      clearable
      style="width: 240px"
    />
    <el-button :loading="loadingRecords" @click="loadAllRecords">刷新</el-button>

    <div class="spacer"></div>
    <el-dropdown :disabled="!zoneId" @command="exportRecords">
      <el-button :disabled="!zoneId">
        导出<el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="csv">导出 CSV</el-dropdown-item>
          <el-dropdown-item command="json">导出 JSON</el-dropdown-item>
          <el-dropdown-item command="bind">导出 BIND (.txt)</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <el-button :disabled="!zoneId" @click="openImport">导入</el-button>
    <el-button type="primary" :disabled="!zoneId" @click="openCreate">
      <el-icon style="margin-right: 4px"><Plus /></el-icon>新增记录
    </el-button>
  </div>

  <el-empty v-if="!store.accounts.length" description="还没有配置 Cloudflare 账号">
    <el-button type="primary" @click="$router.push({ name: 'accounts' })">去添加 Token</el-button>
  </el-empty>

  <template v-else>
    <div v-if="selectedRows.length" class="bulk-bar">
      <span>已选 <b>{{ selectedRows.length }}</b> 条</span>
      <el-button type="danger" size="small" @click="bulkDelete">批量删除</el-button>
      <el-button size="small" @click="openBulkTtl">设置 TTL</el-button>
      <el-button size="small" :disabled="!selectedAllProxyable" @click="bulkProxied(true)">开启代理</el-button>
      <el-button size="small" :disabled="!selectedAllProxyable" @click="bulkProxied(false)">关闭代理</el-button>
      <el-button link size="small" @click="clearSelection">取消选择</el-button>
    </div>

    <el-table
      ref="tableRef"
      v-loading="loadingRecords"
      :data="pagedRecords"
      border
      style="width: 100%"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="44" />
      <el-table-column prop="type" label="类型" width="84" sortable />
      <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
      <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
      <el-table-column label="TTL" width="90">
        <template #default="{ row }">{{ row.ttl === 1 ? '自动' : row.ttl }}</template>
      </el-table-column>
      <el-table-column label="代理" width="88">
        <template #default="{ row }">
          <el-tag v-if="row.proxied" type="warning" size="small">已代理</el-tag>
          <el-tag v-else-if="PROXYABLE.includes(row.type)" type="info" size="small">仅 DNS</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="优先级" width="72">
        <template #default="{ row }">{{ row.priority ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
          <el-button type="danger" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        {{ zoneId ? (allRecords.length ? '没有匹配的记录' : '该域名暂无解析记录') : '请选择账号与域名' }}
      </template>
    </el-table>

    <div class="table-footer">
      <span class="muted">共 {{ filteredRecords.length }} 条</span>
      <el-pagination
        v-if="filteredRecords.length > perPage"
        layout="prev, pager, next, sizes"
        :total="filteredRecords.length"
        :page-size="perPage"
        :page-sizes="[20, 50, 100, 200]"
        :current-page="page"
        @current-change="onPageChange"
        @size-change="(s) => { perPage = s; page = 1; clearSelection(); }"
      />
    </div>
  </template>

  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑记录' : '新增记录'"
    width="560px"
    @closed="editingId = null"
  >
    <el-form label-width="84px">
      <el-form-item label="类型">
        <el-select v-model="form.type" style="width: 100%">
          <el-option v-for="t in RECORD_TYPES" :key="t" :label="t" :value="t" />
        </el-select>
      </el-form-item>
      <el-form-item label="名称">
        <el-input v-model="form.name" placeholder="如 www、@(根)、或完整域名">
          <template v-if="currentZone" #append>.{{ currentZone.name }}</template>
        </el-input>
      </el-form-item>
      <el-form-item label="内容">
        <el-input
          v-model="form.content"
          :placeholder="form.type === 'A' ? 'IPv4 地址' : form.type === 'CNAME' ? '目标域名' : '记录内容'"
        />
      </el-form-item>
      <el-form-item v-if="hasPriority" label="优先级">
        <el-input-number v-model="form.priority" :min="0" :max="65535" />
      </el-form-item>
      <el-form-item v-if="isProxyable" label="代理">
        <el-switch v-model="form.proxied" active-text="经 Cloudflare 代理(橙云)" />
      </el-form-item>
      <el-form-item label="TTL">
        <el-select v-model="form.ttl" :disabled="isProxyable && form.proxied" style="width: 100%">
          <el-option v-for="o in TTL_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.comment" placeholder="可选" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="bulkTtlVisible" title="批量设置 TTL" width="360px">
    <el-select v-model="bulkTtl" style="width: 100%">
      <el-option v-for="o in TTL_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
    </el-select>
    <template #footer>
      <el-button @click="bulkTtlVisible = false">取消</el-button>
      <el-button type="primary" @click="applyBulkTtl">应用到 {{ selectedRows.length }} 条</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="importVisible" title="导入 DNS 记录" width="640px">
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
      <template #default>
        导入规则:<b>同名同类型</b>(二级域名 + 记录类型)的记录会被<b>覆盖更新</b>,不存在的会<b>新增</b>。
        支持 <b>CSV / JSON / BIND(.txt)</b>(自动识别,可先点「导出」拿模板);BIND 即 Cloudflare 导出格式,
        导入跳过 SOA/NS;SRV / CAA 用 JSON 或 BIND 更完整。单次最多 1000 条。
      </template>
    </el-alert>

    <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
      <el-button @click="pickFile">选择文件(CSV / JSON / .txt)</el-button>
      <input ref="fileInput" type="file" accept=".csv,.json,.txt" style="display: none" @change="onFile" />
      <span v-if="importRecords.length" class="muted">已解析 {{ importRecords.length }} 条</span>
      <span v-if="importParseError" style="color: #f56c6c">解析错误:{{ importParseError }}</span>
    </div>

    <el-input
      v-model="importText"
      type="textarea"
      :rows="8"
      placeholder="在此粘贴 CSV / JSON / BIND,或点上方按钮选择文件。CSV 表头:type,name,content,ttl,proxied,priority"
      @input="onImportTextChange"
    />

    <div style="margin-top: 10px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
      <el-checkbox v-model="deleteMissing" @change="importPreview = null">
        完全同步(删除文件中没有的记录,跳过 SOA/NS)
      </el-checkbox>
      <el-button :loading="previewing" :disabled="!importRecords.length" @click="doPreview">预览</el-button>
    </div>

    <el-alert
      v-if="importPreview"
      :type="importPreview.willDelete ? 'error' : 'info'"
      :closable="false"
      style="margin-top: 10px"
    >
      <template #default>
        预览:将<b>新增 {{ importPreview.willCreate }}</b>、<b>覆盖 {{ importPreview.willUpdate }}</b>、<b>删除
        {{ importPreview.willDelete }}</b> 条{{ importPreview.skipped ? `,跳过 ${importPreview.skipped}(SOA/NS)` : ''
        }}{{ importPreview.failed ? `,解析失败 ${importPreview.failed}` : '' }}。
      </template>
    </el-alert>

    <div v-if="importResult" style="margin-top: 12px">
      <el-tag type="success">新增 {{ importResult.created }}</el-tag>
      <el-tag type="warning" style="margin-left: 6px">覆盖 {{ importResult.updated }}</el-tag>
      <el-tag type="danger" style="margin-left: 6px">删除 {{ importResult.deleted || 0 }}</el-tag>
      <el-tag v-if="importResult.skipped" type="info" style="margin-left: 6px">
        跳过 {{ importResult.skipped }}
      </el-tag>
      <el-tag :type="importResult.failed ? 'danger' : 'info'" style="margin-left: 6px">
        失败 {{ importResult.failed }}
      </el-tag>
      <ul
        v-if="importResult.errors && importResult.errors.length"
        class="muted"
        style="max-height: 130px; overflow: auto; margin: 8px 0 0; padding-left: 18px"
      >
        <li v-for="(e, i) in importResult.errors" :key="i">
          {{ e.line ? `第 ${e.line} 行 ` : '' }}{{ e.type }} {{ e.name }}:{{ e.message }}
        </li>
      </ul>
    </div>

    <template #footer>
      <el-button @click="importVisible = false">关闭</el-button>
      <el-button
        type="primary"
        :loading="importing"
        :disabled="!importRecords.length"
        @click="doImport"
      >
        导入{{ importRecords.length ? ` ${importRecords.length} 条` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: #ecf5ff;
  border: 1px solid #d9ecff;
  border-radius: 4px;
}
.table-footer {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
