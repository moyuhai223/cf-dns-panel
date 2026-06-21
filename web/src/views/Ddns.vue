<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAppStore } from '../store/auth';
import { api } from '../api';

const store = useAppStore();
const list = ref([]);
const loading = ref(false);

const base = import.meta.env.BASE_URL; // ends with '/'
function updateUrl(row) {
  return `${window.location.origin}${base}api/ddns/update?key=${row.key}`;
}

async function load() {
  loading.value = true;
  try {
    const r = await api.get('api/ddns');
    list.value = r.ddns;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  try {
    await store.loadAccounts();
  } catch (e) {
    ElMessage.error(e.message);
  }
  await load();
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制更新 URL');
  } catch {
    ElMessage.warning('复制失败,请手动选择复制');
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除 ${row.record_name} 的 DDNS 配置?`, '确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.del(`api/ddns/${row.id}`);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/* ---- create dialog ---- */
const dialogVisible = ref(false);
const accountId = ref(null);
const zones = ref([]);
const zoneId = ref(null);
const records = ref([]);
const recordId = ref(null);
const loadingZones = ref(false);
const loadingRecords = ref(false);
const saving = ref(false);

const currentZone = computed(() => zones.value.find((z) => z.id === zoneId.value));
const currentRecord = computed(() => records.value.find((r) => r.id === recordId.value));

function openCreate() {
  if (!store.accounts.length) return ElMessage.warning('请先在「账号 / Token」添加 Token');
  accountId.value = store.accounts[0].id;
  zones.value = [];
  zoneId.value = null;
  records.value = [];
  recordId.value = null;
  dialogVisible.value = true;
  loadZones();
}

async function loadZones() {
  zones.value = [];
  zoneId.value = null;
  records.value = [];
  recordId.value = null;
  if (!accountId.value) return;
  loadingZones.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/zones`);
    zones.value = r.zones;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingZones.value = false;
  }
}

async function loadRecords() {
  records.value = [];
  recordId.value = null;
  if (!zoneId.value) return;
  loadingRecords.value = true;
  try {
    const r = await api.get(`api/zones/${zoneId.value}/export`, { accountId: accountId.value });
    records.value = (r.records || []).filter((x) => x.type === 'A' || x.type === 'AAAA');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingRecords.value = false;
  }
}

async function save() {
  if (!recordId.value) return ElMessage.warning('请选择要动态更新的记录');
  const rec = currentRecord.value;
  saving.value = true;
  try {
    await api.post('api/ddns', {
      accountId: accountId.value,
      zoneId: zoneId.value,
      zoneName: currentZone.value?.name,
      recordId: rec.id,
      recordName: rec.name,
      recordType: rec.type,
    });
    ElMessage.success('已创建,复制更新 URL 到你的设备上定时调用');
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="toolbar">
    <h2 style="margin: 0">DDNS 动态解析</h2>
    <div class="spacer"></div>
    <el-button type="primary" @click="openCreate">
      <el-icon style="margin-right: 4px"><Plus /></el-icon>新增 DDNS
    </el-button>
  </div>

  <el-alert type="info" :closable="false" style="margin-bottom: 14px">
    给某条 A / AAAA 记录生成一个专属更新 URL,在你的服务器 / 路由器上定时调用即可把该记录更新为调用方的公网 IP。
    示例(每 5 分钟,加到 crontab):
    <code>*/5 * * * * curl -fsS "https://你的面板域名{{ base }}api/ddns/update?key=KEY"</code>
    也可显式指定 IP:<code>...&amp;ip=1.2.3.4</code>。IP 未变化时返回 <code>nochg</code>,不会重复写 Cloudflare。
  </el-alert>

  <el-table v-loading="loading" :data="list" border style="width: 100%">
    <el-table-column label="记录" min-width="220">
      <template #default="{ row }">
        {{ row.record_name }} <el-tag size="small" type="info">{{ row.record_type }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="zone_name" label="域名" min-width="140" />
    <el-table-column label="最近 IP" width="160">
      <template #default="{ row }">{{ row.last_ip || '—' }}</template>
    </el-table-column>
    <el-table-column prop="updated_at" label="更新时间" width="180">
      <template #default="{ row }">{{ row.updated_at || '尚未更新' }}</template>
    </el-table-column>
    <el-table-column label="更新 URL" min-width="240">
      <template #default="{ row }">
        <el-button size="small" @click="copy(updateUrl(row))">复制更新 URL</el-button>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="90">
      <template #default="{ row }">
        <el-button type="danger" link @click="remove(row)">删除</el-button>
      </template>
    </el-table-column>
    <template #empty>还没有 DDNS 配置</template>
  </el-table>

  <el-dialog v-model="dialogVisible" title="新增 DDNS" width="520px">
    <el-form label-width="84px">
      <el-form-item label="账号">
        <el-select v-model="accountId" style="width: 100%" @change="loadZones">
          <el-option
            v-for="a in store.accounts"
            :key="a.id"
            :label="`${a.label} (····${a.token_last4})`"
            :value="a.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="域名">
        <el-select
          v-model="zoneId"
          filterable
          style="width: 100%"
          :loading="loadingZones"
          @change="loadRecords"
        >
          <el-option v-for="z in zones" :key="z.id" :label="z.name" :value="z.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="记录">
        <el-select
          v-model="recordId"
          filterable
          style="width: 100%"
          :loading="loadingRecords"
          placeholder="仅 A / AAAA 记录"
        >
          <el-option
            v-for="r in records"
            :key="r.id"
            :label="`${r.type}  ${r.name}  (${r.content})`"
            :value="r.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">创建</el-button>
    </template>
  </el-dialog>
</template>
