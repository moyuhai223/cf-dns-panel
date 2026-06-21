<script setup>
import { ref, onMounted } from 'vue';
import { useAppStore } from '../store/auth';
import { api } from '../api';

const store = useAppStore();
const accountId = ref(null);
const zones = ref([]);
const zoneId = ref(null);
const loadingZones = ref(false);

const settings = ref({});
const loading = ref(false);
const savingKey = ref('');

const purgeText = ref('');
const purging = ref(false);

const CACHE_LEVELS = [
  { label: '标准(缓存静态资源)', value: 'aggressive' },
  { label: '基础(忽略查询串后缀)', value: 'basic' },
  { label: '忽略查询字符串', value: 'simplified' },
];
const BROWSER_TTL = [
  { label: '遵循源站', value: 0 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '2 小时', value: 7200 },
  { label: '4 小时', value: 14400 },
  { label: '8 小时', value: 28800 },
  { label: '1 天', value: 86400 },
  { label: '7 天', value: 604800 },
  { label: '1 个月', value: 2678400 },
  { label: '1 年', value: 31536000 },
];
const SSL_MODES = [
  { label: '关(Off)', value: 'off' },
  { label: '灵活(Flexible)', value: 'flexible' },
  { label: '完全(Full)', value: 'full' },
  { label: '完全(严格)', value: 'strict' },
];

const currentZone = () => zones.value.find((z) => z.id === zoneId.value);
const sval = (k) => settings.value[k]?.value;
const savail = (k) => !!settings.value[k]; // setting present (available on plan/perm)

onMounted(async () => {
  try {
    await store.loadAccounts();
    if (store.accounts.length) {
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
  settings.value = {};
  if (!accountId.value) return;
  loadingZones.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/zones`);
    zones.value = r.zones;
    if (zones.value.length === 1) {
      zoneId.value = zones.value[0].id;
      await loadSettings();
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingZones.value = false;
  }
}

async function loadSettings() {
  settings.value = {};
  if (!zoneId.value) return;
  loading.value = true;
  try {
    const r = await api.get('api/cache/settings', { accountId: accountId.value, zoneId: zoneId.value });
    settings.value = r.settings || {};
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function patch(key, value) {
  savingKey.value = key;
  try {
    const r = await api.patch('api/cache/settings', {
      accountId: accountId.value,
      zoneId: zoneId.value,
      zoneName: currentZone()?.name,
      key,
      value,
    });
    settings.value[key] = { ...settings.value[key], value: r.setting.value };
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
    await loadSettings(); // re-sync on failure
  } finally {
    savingKey.value = '';
  }
}

async function purgeAll() {
  try {
    await ElMessageBox.confirm(`清除 ${currentZone()?.name} 的全部缓存?`, '清除缓存', { type: 'warning' });
  } catch {
    return;
  }
  purging.value = true;
  try {
    await api.post('api/cache/purge', {
      accountId: accountId.value,
      zoneId: zoneId.value,
      zoneName: currentZone()?.name,
      everything: true,
    });
    ElMessage.success('已提交全部清除');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    purging.value = false;
  }
}

async function purgeByUrl() {
  const files = purgeText.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return ElMessage.warning('请粘贴要清除的完整 URL,每行一个');
  purging.value = true;
  try {
    await api.post('api/cache/purge', {
      accountId: accountId.value,
      zoneId: zoneId.value,
      zoneName: currentZone()?.name,
      files,
    });
    ElMessage.success(`已提交清除 ${files.length} 条 URL`);
    purgeText.value = '';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    purging.value = false;
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
      @change="loadSettings"
    >
      <el-option v-for="z in zones" :key="z.id" :label="z.name" :value="z.id" />
    </el-select>
    <el-button :loading="loading" :disabled="!zoneId" @click="loadSettings">刷新</el-button>
  </div>

  <el-alert type="info" :closable="false" style="margin-bottom: 14px">
    缓存与设置需要 Token 具备 <b>缓存清除</b> 与 <b>区域设置</b> 权限;若令牌只有 DNS 权限,这里的操作会报权限错误,
    请在 Cloudflare 给令牌补上对应权限。
  </el-alert>

  <el-empty v-if="!zoneId" description="请选择账号与域名" />

  <template v-else>
    <el-card v-loading="loading" header="清除缓存" style="margin-bottom: 16px">
      <el-button type="danger" :loading="purging" @click="purgeAll">清除全部缓存</el-button>
      <div style="margin-top: 12px">
        <el-input
          v-model="purgeText"
          type="textarea"
          :rows="3"
          placeholder="按 URL 清除:每行一个完整 URL,如 https://example.com/style.css(单次最多 30 条)"
        />
        <el-button style="margin-top: 8px" :loading="purging" @click="purgeByUrl">清除这些 URL</el-button>
      </div>
    </el-card>

    <el-card v-loading="loading" header="缓存与 HTTPS 设置">
      <el-form label-width="160px">
        <el-form-item label="开发模式(3 小时绕过缓存)">
          <el-switch
            :model-value="sval('development_mode') === 'on'"
            :disabled="!savail('development_mode') || savingKey === 'development_mode'"
            @change="(v) => patch('development_mode', v ? 'on' : 'off')"
          />
        </el-form-item>
        <el-form-item label="缓存级别">
          <el-select
            :model-value="sval('cache_level')"
            :disabled="!savail('cache_level')"
            style="width: 280px"
            @change="(v) => patch('cache_level', v)"
          >
            <el-option v-for="o in CACHE_LEVELS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="浏览器缓存 TTL">
          <el-select
            :model-value="sval('browser_cache_ttl')"
            :disabled="!savail('browser_cache_ttl')"
            style="width: 280px"
            @change="(v) => patch('browser_cache_ttl', v)"
          >
            <el-option v-for="o in BROWSER_TTL" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="Always Online">
          <el-switch
            :model-value="sval('always_online') === 'on'"
            :disabled="!savail('always_online') || savingKey === 'always_online'"
            @change="(v) => patch('always_online', v ? 'on' : 'off')"
          />
        </el-form-item>
        <el-form-item label="始终使用 HTTPS">
          <el-switch
            :model-value="sval('always_use_https') === 'on'"
            :disabled="!savail('always_use_https') || savingKey === 'always_use_https'"
            @change="(v) => patch('always_use_https', v ? 'on' : 'off')"
          />
        </el-form-item>
        <el-form-item label="SSL/TLS 模式">
          <el-select
            :model-value="sval('ssl')"
            :disabled="!savail('ssl')"
            style="width: 280px"
            @change="(v) => patch('ssl', v)"
          >
            <el-option v-for="o in SSL_MODES" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>
  </template>
</template>
