<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const perPage = 50;
const loading = ref(false);

const ACTION_LABEL = { create: '新增', update: '修改', delete: '删除' };
const ACTION_TYPE = { create: 'success', update: 'warning', delete: 'danger' };

async function load() {
  loading.value = true;
  try {
    const r = await api.get('api/audit', { page: page.value, perPage });
    rows.value = r.rows;
    total.value = r.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function onPageChange(p) {
  page.value = p;
  load();
}
</script>

<template>
  <div class="toolbar">
    <h2 style="margin: 0">审计日志</h2>
    <div class="spacer"></div>
    <el-button :loading="loading" @click="load">刷新</el-button>
  </div>

  <el-table v-loading="loading" :data="rows" border style="width: 100%">
    <el-table-column prop="ts" label="时间(UTC)" width="180" />
    <el-table-column prop="username" label="操作者" width="110" />
    <el-table-column label="动作" width="90">
      <template #default="{ row }">
        <el-tag :type="ACTION_TYPE[row.action] || 'info'" size="small">
          {{ ACTION_LABEL[row.action] || row.action }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="zone_name" label="域名" min-width="160" show-overflow-tooltip />
    <el-table-column prop="rr_type" label="类型" width="80" />
    <el-table-column prop="rr_name" label="记录名" min-width="180" show-overflow-tooltip />
    <el-table-column prop="client_ip" label="来源 IP" width="140" />
    <el-table-column label="详情" min-width="200">
      <template #default="{ row }">
        <span class="muted">{{ row.detail_json }}</span>
      </template>
    </el-table-column>
    <template #empty>暂无日志</template>
  </el-table>

  <div style="margin-top: 12px; display: flex; justify-content: flex-end">
    <el-pagination
      v-if="total > perPage"
      layout="prev, pager, next, total"
      :total="total"
      :page-size="perPage"
      :current-page="page"
      @current-change="onPageChange"
    />
  </div>
</template>
