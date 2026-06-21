<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAppStore } from '../store/auth';
import { api } from '../api';
import { toCsv, simplify, parseImport } from '../dnsio';

const store = useAppStore();

const accountId = ref(null);
const zones = ref([]);
const zoneId = ref(null);
const loadingZones = ref(false);

const records = ref([]);
const loadingRecords = ref(false);
const filterType = ref('');
const searchName = ref('');
const page = ref(1);
const perPage = 100;
const totalCount = ref(0);

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

onMounted(async () => {
  try {
    await store.loadAccounts();
    if (store.accounts.length >= 1) {
      accountId.value = store.accounts[0].id;
      await loadZones();
    }
  } catch (e) {
    ElMessage.error(e.message);
  }
});

async function loadZones() {
  zones.value = [];
  zoneId.value = null;
  records.value = [];
  if (!accountId.value) return;
  loadingZones.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/zones`);
    zones.value = r.zones;
    if (zones.value.length === 1) {
      zoneId.value = zones.value[0].id;
      await loadRecords();
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingZones.value = false;
  }
}

async function loadRecords() {
  if (!zoneId.value) {
    records.value = [];
    return;
  }
  loadingRecords.value = true;
  try {
    const r = await api.get(`api/zones/${zoneId.value}/records`, {
      accountId: accountId.value,
      type: filterType.value || undefined,
      name: searchName.value || undefined,
      page: page.value,
    });
    records.value = r.records;
    totalCount.value = r.result_info?.total_count ?? r.records.length;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingRecords.value = false;
  }
}

function onZoneChange() {
  page.value = 1;
  loadRecords();
}
watch(filterType, () => {
  page.value = 1;
  loadRecords();
});
function onSearch() {
  page.value = 1;
  loadRecords();
}
function onPageChange(p) {
  page.value = p;
  loadRecords();
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

function openEdit(row) {
  editingId.value = row.id;
  resetForm({
    type: row.type,
    name: row.name,
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
    await loadRecords();
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
    await loadRecords();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/* ---- export ---- */
async function exportRecords(format) {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  try {
    const r = await api.get(`api/zones/${zoneId.value}/export`, { accountId: accountId.value });
    const recs = (r.records || []).map(simplify);
    const zone = currentZone.value?.name || 'zone';
    if (format === 'json') {
      downloadFile(`${zone}-dns.json`, JSON.stringify(recs, null, 2), 'application/json');
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
const importResult = ref(null);
const fileInput = ref(null);

function openImport() {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  importText.value = '';
  importRecords.value = [];
  importParseError.value = '';
  importResult.value = null;
  importVisible.value = true;
}

function onImportTextChange() {
  importResult.value = null;
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

async function doImport() {
  if (!importRecords.value.length) return;
  try {
    await ElMessageBox.confirm(
      `将导入 ${importRecords.value.length} 条记录到 ${currentZone.value?.name}。同名同类型的现有记录会被覆盖更新,确定继续?`,
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
    });
    importResult.value = res;
    ElMessage.success(`导入完成:新增 ${res.created}、覆盖 ${res.updated}、失败 ${res.failed}`);
    await loadRecords();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="toolbar">
    <el-select
      v-model="accountId"
      placeholder="选择账号"
      style="width: 170px"
      @change="loadZones"
    >
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
      v-model="searchName"
      placeholder="按名称搜索"
      clearable
      style="width: 220px"
      @keyup.enter="onSearch"
      @clear="onSearch"
    />
    <el-button @click="onSearch">搜索</el-button>
    <el-button :loading="loadingRecords" @click="loadRecords">刷新</el-button>

    <div class="spacer"></div>
    <el-dropdown :disabled="!zoneId" @command="exportRecords">
      <el-button :disabled="!zoneId">
        导出<el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="csv">导出 CSV</el-dropdown-item>
          <el-dropdown-item command="json">导出 JSON</el-dropdown-item>
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
    <el-table v-loading="loadingRecords" :data="records" border style="width: 100%">
      <el-table-column prop="type" label="类型" width="90" sortable />
      <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
      <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
      <el-table-column label="TTL" width="100">
        <template #default="{ row }">{{ row.ttl === 1 ? '自动' : row.ttl }}</template>
      </el-table-column>
      <el-table-column label="代理" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.proxied" type="warning" size="small">已代理</el-tag>
          <el-tag v-else-if="PROXYABLE.includes(row.type)" type="info" size="small">仅 DNS</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="优先级" width="80">
        <template #default="{ row }">{{ row.priority ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
          <el-button type="danger" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        {{ zoneId ? '该域名暂无解析记录' : '请选择账号与域名' }}
      </template>
    </el-table>

    <div style="margin-top: 12px; display: flex; justify-content: flex-end">
      <el-pagination
        v-if="totalCount > perPage"
        layout="prev, pager, next, total"
        :total="totalCount"
        :page-size="perPage"
        :current-page="page"
        @current-change="onPageChange"
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

  <el-dialog v-model="importVisible" title="导入 DNS 记录" width="640px">
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
      <template #default>
        导入规则:<b>同名同类型</b>(二级域名 + 记录类型)的记录会被<b>覆盖更新</b>,不存在的会<b>新增</b>;
        文件里没有列出的现有记录<b>不会被删除</b>。支持 CSV 或 JSON(可先点「导出」拿到模板);
        SRV / CAA 等结构化记录请用 <b>JSON</b> 导入,CSV 无法完整表达。单次最多 1000 条。
      </template>
    </el-alert>

    <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
      <el-button @click="pickFile">选择文件(CSV / JSON)</el-button>
      <input
        ref="fileInput"
        type="file"
        accept=".csv,.json,.txt"
        style="display: none"
        @change="onFile"
      />
      <span v-if="importRecords.length" class="muted">已解析 {{ importRecords.length }} 条</span>
      <span v-if="importParseError" style="color: #f56c6c">解析错误:{{ importParseError }}</span>
    </div>

    <el-input
      v-model="importText"
      type="textarea"
      :rows="9"
      placeholder="在此粘贴 CSV 或 JSON,或点上方按钮选择文件。CSV 表头:type,name,content,ttl,proxied,priority"
      @input="onImportTextChange"
    />

    <div v-if="importResult" style="margin-top: 12px">
      <el-tag type="success">新增 {{ importResult.created }}</el-tag>
      <el-tag type="warning" style="margin-left: 6px">覆盖 {{ importResult.updated }}</el-tag>
      <el-tag :type="importResult.failed ? 'danger' : 'info'" style="margin-left: 6px">
        失败 {{ importResult.failed }}
      </el-tag>
      <ul
        v-if="importResult.errors && importResult.errors.length"
        class="muted"
        style="max-height: 130px; overflow: auto; margin: 8px 0 0; padding-left: 18px"
      >
        <li v-for="(e, i) in importResult.errors" :key="i">
          第 {{ e.line }} 行 {{ e.type }} {{ e.name }}:{{ e.message }}
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
