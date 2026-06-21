<script setup>
import { ref, onMounted } from 'vue';
import { CircleCheck, CircleClose, Warning } from '@element-plus/icons-vue';
import { useAppStore } from '../store/auth';
import { api } from '../api';

const store = useAppStore();
const loading = ref(false);

const checkVisible = ref(false);
const checking = ref(false);
const checkResult = ref(null);
const CHECK_ITEMS = [
  { key: 'zones', label: '列出域名(Zone:Read)' },
  { key: 'dnsRead', label: '读取 DNS 记录' },
  { key: 'zoneSettings', label: '读取区域设置(缓存 / SSL)' },
  { key: 'rules', label: '读取规则(Rulesets)' },
];

async function runCheck(row) {
  checkResult.value = null;
  checkVisible.value = true;
  checking.value = true;
  try {
    checkResult.value = await api.get(`api/accounts/${row.id}/check`);
  } catch (e) {
    ElMessage.error(e.message);
    checkVisible.value = false;
  } finally {
    checking.value = false;
  }
}

const dialogVisible = ref(false);
const form = ref({ label: '', token: '' });
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    await store.loadAccounts();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openAdd() {
  form.value = { label: '', token: '' };
  dialogVisible.value = true;
}

async function save() {
  if (!form.value.token.trim()) return ElMessage.warning('请填写 API Token');
  saving.value = true;
  try {
    await api.post('api/accounts', { label: form.value.label, token: form.value.token });
    ElMessage.success('Token 校验通过并已保存');
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除账号「${row.label}」?`, '确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.del(`api/accounts/${row.id}`);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="toolbar">
    <h2 style="margin: 0">Cloudflare 账号 / API Token</h2>
    <div class="spacer"></div>
    <el-button type="primary" @click="openAdd">
      <el-icon style="margin-right: 4px"><Plus /></el-icon>添加 Token
    </el-button>
  </div>

  <el-alert type="info" :closable="false" style="margin-bottom: 14px">
    在 Cloudflare → 个人资料 → API 令牌 创建令牌,权限至少需要
    <b>区域 - DNS - 编辑</b> 与 <b>区域 - 区域 - 读取</b>(可作用于全部或指定区域)。
    Token 仅在此校验后<b>加密存储</b>,列表只显示末 4 位。
  </el-alert>

  <el-table v-loading="loading" :data="store.accounts" border>
    <el-table-column prop="id" label="ID" width="70" />
    <el-table-column prop="label" label="名称" />
    <el-table-column label="Token" width="160">
      <template #default="{ row }">····{{ row.token_last4 }}</template>
    </el-table-column>
    <el-table-column prop="created_at" label="添加时间" width="200" />
    <el-table-column label="操作" width="150">
      <template #default="{ row }">
        <el-button type="primary" link @click="runCheck(row)">自检</el-button>
        <el-button type="danger" link @click="remove(row)">删除</el-button>
      </template>
    </el-table-column>
    <template #empty>暂无账号,请先添加一个 API Token</template>
  </el-table>

  <el-dialog v-model="checkVisible" title="Token 权限自检" width="480px">
    <div v-loading="checking" style="min-height: 60px">
      <p v-if="checkResult && checkResult.sampleZone" class="muted" style="margin-top: 0">
        基于域名 {{ checkResult.sampleZone }} 只读探测
      </p>
      <ul v-if="checkResult" style="list-style: none; padding: 0; margin: 0">
        <li
          v-for="it in CHECK_ITEMS"
          :key="it.key"
          style="display: flex; align-items: center; gap: 8px; padding: 6px 0"
        >
          <el-icon v-if="checkResult.checks[it.key] && checkResult.checks[it.key].ok" color="#67c23a">
            <CircleCheck />
          </el-icon>
          <el-icon v-else-if="checkResult.checks[it.key]" color="#f56c6c"><CircleClose /></el-icon>
          <el-icon v-else color="#909399"><Warning /></el-icon>
          <span>{{ it.label }}</span>
          <span style="margin-left: auto" class="muted">
            <template v-if="it.key === 'zones' && checkResult.checks.zones && checkResult.checks.zones.ok">
              {{ checkResult.checks.zones.count }} 个
            </template>
            <template v-else-if="checkResult.checks[it.key] && !checkResult.checks[it.key].ok">
              {{ checkResult.checks[it.key].message || '无权限' }}
            </template>
          </span>
        </li>
      </ul>
      <el-alert type="info" :closable="false" style="margin-top: 10px">
        改记录 / 清缓存 / 改规则 等写操作无法只读探测,使用时若报 403 即为权限不足。
      </el-alert>
    </div>
    <template #footer><el-button @click="checkVisible = false">关闭</el-button></template>
  </el-dialog>

  <el-dialog v-model="dialogVisible" title="添加 Cloudflare API Token" width="520px">
    <el-form label-width="80px">
      <el-form-item label="名称">
        <el-input v-model="form.label" placeholder="便于区分,如:主账号" />
      </el-form-item>
      <el-form-item label="Token">
        <el-input
          v-model="form.token"
          type="password"
          show-password
          placeholder="粘贴 Cloudflare API Token"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">校验并保存</el-button>
    </template>
  </el-dialog>
</template>
