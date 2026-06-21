<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../store/auth';
import { api } from '../api';

const store = useAppStore();
const router = useRouter();

const accountId = ref(null);
const query = ref('');
const filterType = ref('');
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

const loading = ref(false);
const searched = ref(false);
const results = ref([]);
const meta = ref(null);

onMounted(async () => {
  try {
    await store.loadAccounts();
    if (store.accounts.length) accountId.value = store.accounts[0].id;
  } catch (e) {
    ElMessage.error(e.message);
  }
});

async function doSearch() {
  if (!accountId.value) return ElMessage.warning('请先选择账号');
  if (!query.value.trim() && !filterType.value) return ElMessage.warning('请输入搜索词或选择类型');
  loading.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/search`, {
      q: query.value.trim() || undefined,
      type: filterType.value || undefined,
    });
    results.value = r.results || [];
    meta.value = r;
    searched.value = true;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function manage(row) {
  router.push({ name: 'records', query: { accountId: accountId.value, zoneId: row.zoneId } });
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `删除 ${row.zoneName} 的记录 ${row.record.type} ${row.record.name}?`,
      '删除确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await api.del(`api/zones/${row.zoneId}/records/${row.record.id}`, {
      accountId: accountId.value,
      zoneName: row.zoneName,
      rrType: row.record.type,
      rrName: row.record.name,
    });
    ElMessage.success('已删除');
    results.value = results.value.filter((x) => !(x.zoneId === row.zoneId && x.record.id === row.record.id));
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="toolbar">
    <el-select v-model="accountId" placeholder="选择账号" style="width: 170px">
      <el-option
        v-for="a in store.accounts"
        :key="a.id"
        :label="`${a.label} (····${a.token_last4})`"
        :value="a.id"
      />
    </el-select>
    <el-select v-model="filterType" placeholder="类型" clearable style="width: 110px">
      <el-option v-for="t in RECORD_TYPES" :key="t" :label="t" :value="t" />
    </el-select>
    <el-input
      v-model="query"
      placeholder="跨所有域名搜索 名称 / 内容 / 备注"
      clearable
      style="width: 320px"
      @keyup.enter="doSearch"
    />
    <el-button type="primary" :loading="loading" @click="doSearch">搜索</el-button>
  </div>

  <el-alert type="info" :closable="false" style="margin-bottom: 12px">
    在选定账号下,把搜索词在<b>所有域名</b>的解析记录里逐一匹配(名称 / 内容 / 备注)。域名很多时会多次调用 Cloudflare,
    略慢;最多搜 200 个域名、返回 500 条结果。
  </el-alert>

  <div v-if="meta" class="muted" style="margin-bottom: 8px">
    搜索了 {{ meta.zonesSearched }} / {{ meta.totalZones }} 个域名,命中 {{ results.length }} 条<span
      v-if="meta.truncated"
      style="color: #e6a23c"
    >(结果已截断,请缩小范围)</span><span v-if="meta.errors && meta.errors.length" style="color: #f56c6c">
      ,{{ meta.errors.length }} 个域名读取失败</span
    >。
  </div>

  <el-table
    v-if="searched"
    v-loading="loading"
    :data="results"
    border
    style="width: 100%"
  >
    <el-table-column prop="zoneName" label="域名" min-width="160" show-overflow-tooltip />
    <el-table-column label="类型" width="84">
      <template #default="{ row }">{{ row.record.type }}</template>
    </el-table-column>
    <el-table-column label="名称" min-width="200" show-overflow-tooltip>
      <template #default="{ row }">{{ row.record.name }}</template>
    </el-table-column>
    <el-table-column label="内容" min-width="240" show-overflow-tooltip>
      <template #default="{ row }">{{ row.record.content }}</template>
    </el-table-column>
    <el-table-column label="代理" width="80">
      <template #default="{ row }">
        <el-tag v-if="row.record.proxied" type="warning" size="small">已代理</el-tag>
        <span v-else class="muted">—</span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="150" fixed="right">
      <template #default="{ row }">
        <el-button type="primary" link @click="manage(row)">去管理</el-button>
        <el-button type="danger" link @click="remove(row)">删除</el-button>
      </template>
    </el-table-column>
    <template #empty>没有匹配的记录</template>
  </el-table>
</template>
