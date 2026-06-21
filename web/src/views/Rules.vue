<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useAppStore } from '../store/auth';
import { api } from '../api';

const store = useAppStore();
const accountId = ref(null);
const zones = ref([]);
const zoneId = ref(null);
const loadingZones = ref(false);
const currentZone = () => zones.value.find((z) => z.id === zoneId.value);

const PHASES = [
  { key: 'cache', phase: 'http_request_cache_settings', label: '缓存规则' },
  { key: 'redirect', phase: 'http_request_dynamic_redirect', label: '重定向规则' },
  { key: 'headers', phase: 'http_response_headers_transform', label: '转换 · 响应头' },
];
const PHASE_ACTION = { cache: 'set_cache_settings', redirect: 'redirect', headers: 'rewrite' };
const activeTab = ref('cache');
const currentPhase = computed(() => PHASES.find((p) => p.key === activeTab.value));

const EXPR_HINT = {
  cache: '示例:(http.request.uri.path contains "/static/")  或  (http.host eq "img.example.com")',
  redirect: '示例:(http.request.uri.path eq "/old")  或  (http.host eq "www.example.com")',
  headers: '示例:(http.request.uri.path contains "/")  对全站响应加头',
};

const TTL_OPTS = [
  { label: '遵循源站', value: 'respect' },
  { label: '30 秒', value: 30 },
  { label: '1 分钟', value: 60 },
  { label: '5 分钟', value: 300 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '1 天', value: 86400 },
  { label: '1 个月', value: 2592000 },
];

// One-click presets per phase. build(zoneName) returns a CF rule object.
const STATIC_EXTS = ['css', 'js', 'mjs', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'pdf'];
const staticExpr = `(${STATIC_EXTS.map((e) => `ends_with(lower(http.request.uri.path), ".${e}")`).join(' or ')})`;
const ALL_PATHS = '(starts_with(http.request.uri.path, "/"))';

const TEMPLATES = {
  cache: [
    {
      label: '缓存静态资源(JS/CSS/图片/字体,边缘 1 月 / 浏览器 1 天)',
      build: () => ({
        description: '缓存静态资源',
        expression: staticExpr,
        enabled: true,
        action: 'set_cache_settings',
        action_parameters: {
          cache: true,
          edge_ttl: { mode: 'override_origin', default: 2592000 },
          browser_ttl: { mode: 'override_origin', default: 86400 },
        },
      }),
    },
    {
      label: '不缓存 WordPress 后台(/wp-admin、wp-login.php)',
      build: () => ({
        description: '后台不缓存',
        expression: '(starts_with(http.request.uri.path, "/wp-admin") or http.request.uri.path eq "/wp-login.php")',
        enabled: true,
        action: 'set_cache_settings',
        action_parameters: { cache: false },
      }),
    },
    {
      label: '不缓存接口(/api/*)',
      build: () => ({
        description: 'API 不缓存',
        expression: '(starts_with(http.request.uri.path, "/api/"))',
        enabled: true,
        action: 'set_cache_settings',
        action_parameters: { cache: false },
      }),
    },
  ],
  redirect: [
    {
      label: 'www 跳转到根域名(301,保留路径)',
      build: (zone) => ({
        description: 'www → 根域名',
        expression: `(http.host eq "www.${zone}")`,
        enabled: true,
        action: 'redirect',
        action_parameters: {
          from_value: {
            target_url: { expression: `concat("https://${zone}", http.request.uri.path)` },
            status_code: 301,
            preserve_query_string: true,
          },
        },
      }),
    },
    {
      label: '根域名跳转到 www(301,保留路径)',
      build: (zone) => ({
        description: '根域名 → www',
        expression: `(http.host eq "${zone}")`,
        enabled: true,
        action: 'redirect',
        action_parameters: {
          from_value: {
            target_url: { expression: `concat("https://www.${zone}", http.request.uri.path)` },
            status_code: 301,
            preserve_query_string: true,
          },
        },
      }),
    },
  ],
  headers: [
    {
      label: '常用安全响应头(X-Frame-Options / nosniff / Referrer-Policy)',
      build: () => ({
        description: '安全响应头',
        expression: ALL_PATHS,
        enabled: true,
        action: 'rewrite',
        action_parameters: {
          headers: {
            'X-Frame-Options': { operation: 'set', value: 'SAMEORIGIN' },
            'X-Content-Type-Options': { operation: 'set', value: 'nosniff' },
            'Referrer-Policy': { operation: 'set', value: 'strict-origin-when-cross-origin' },
          },
        },
      }),
    },
    {
      label: 'HSTS 强制 HTTPS(1 年,含子域)',
      build: () => ({
        description: 'HSTS',
        expression: ALL_PATHS,
        enabled: true,
        action: 'rewrite',
        action_parameters: {
          headers: {
            'Strict-Transport-Security': { operation: 'set', value: 'max-age=31536000; includeSubDomains' },
          },
        },
      }),
    },
    {
      label: '删除暴露信息的响应头(X-Powered-By 等)',
      build: () => ({
        description: '隐藏后端信息',
        expression: ALL_PATHS,
        enabled: true,
        action: 'rewrite',
        action_parameters: {
          headers: {
            'X-Powered-By': { operation: 'remove' },
            'X-AspNet-Version': { operation: 'remove' },
            'X-AspNetMvc-Version': { operation: 'remove' },
          },
        },
      }),
    },
  ],
};
const currentTemplates = computed(() => TEMPLATES[activeTab.value] || []);

const rules = ref([]); // local working copy of CF rule objects
const loading = ref(false);
const saving = ref(false);
const dirty = ref(false);

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
  rules.value = [];
  if (!accountId.value) return;
  loadingZones.value = true;
  try {
    const r = await api.get(`api/accounts/${accountId.value}/zones`);
    zones.value = r.zones;
    if (zones.value.length === 1) {
      zoneId.value = zones.value[0].id;
      await loadRules();
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loadingZones.value = false;
  }
}

async function loadRules() {
  rules.value = [];
  dirty.value = false;
  if (!zoneId.value) return;
  loading.value = true;
  try {
    const r = await api.get(`api/rules/${currentPhase.value.phase}`, {
      accountId: accountId.value,
      zoneId: zoneId.value,
    });
    rules.value = r.rules || [];
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
watch(activeTab, loadRules);

async function confirmTabSwitch(next) {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前改动未保存,切换将丢弃。继续?', '未保存', { type: 'warning' });
    } catch {
      return;
    }
  }
  activeTab.value = next;
}

/* ---- editor ---- */
const dialogVisible = ref(false);
const editIndex = ref(-1);
const DEFAULTS = {
  _orig: null,
  description: '',
  expression: '',
  enabled: true,
  cacheBehavior: 'cache',
  edgeTtl: 'respect',
  browserTtl: 'respect',
  targetUrl: '',
  statusCode: 301,
  preserveQuery: true,
  headerOps: [{ name: '', operation: 'set', value: '' }],
};
const form = reactive({ ...DEFAULTS });

function resetForm() {
  Object.assign(form, DEFAULTS, { headerOps: [{ name: '', operation: 'set', value: '' }] });
}
function openAdd() {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  editIndex.value = -1;
  resetForm();
  dialogVisible.value = true;
}

function addTemplate(idx) {
  if (!zoneId.value) return ElMessage.warning('请先选择域名');
  const t = currentTemplates.value[idx];
  if (!t) return;
  rules.value.push(t.build(currentZone()?.name || ''));
  dirty.value = true;
  ElMessage.success(`已添加「${t.label.split('(')[0]}」,检查无误后点「保存到 Cloudflare」`);
}
function openEdit(rule, idx) {
  // Don't reinterpret a rule whose action doesn't belong to the active phase — it
  // would be rewritten into the wrong type and corrupted.
  if (rule.action && rule.action !== PHASE_ACTION[activeTab.value]) {
    return ElMessage.warning('该规则的动作与当前类型不符,暂不支持在此编辑');
  }
  editIndex.value = idx;
  resetForm();
  form._orig = JSON.parse(JSON.stringify(rule)); // preserve fields the form doesn't expose
  form.description = rule.description || '';
  form.expression = rule.expression || '';
  form.enabled = rule.enabled !== false;
  const ap = rule.action_parameters || {};
  if (activeTab.value === 'cache') {
    form.cacheBehavior = ap.cache === false ? 'bypass' : 'cache';
    form.edgeTtl = ttlFromCf(ap.edge_ttl);
    form.browserTtl = ttlFromCf(ap.browser_ttl);
  } else if (activeTab.value === 'redirect') {
    const fv = ap.from_value || {};
    form.targetUrl = fv.target_url?.value ?? fv.target_url?.expression ?? '';
    form.statusCode = fv.status_code || 301;
    form.preserveQuery = fv.preserve_query_string === true; // CF default is false
  } else {
    const h = ap.headers || {};
    const ops = Object.entries(h).map(([name, v]) => ({
      name,
      operation: v.operation || 'set',
      value: v.value || '',
      expression: v.expression || '',
    }));
    form.headerOps = ops.length ? ops : [{ name: '', operation: 'set', value: '' }];
  }
  dialogVisible.value = true;
}

function ttlFromCf(t) {
  if (!t || t.mode === 'respect_origin') return 'respect';
  if (t.mode === 'override_origin') return t.default ?? 'respect';
  return 'respect';
}
function mergeTtl(orig, v) {
  if (v === 'respect') return { mode: 'respect_origin' };
  const out = orig && typeof orig === 'object' ? { ...orig } : {}; // keep extras (status_code_ttl…)
  out.mode = 'override_origin';
  out.default = Number(v);
  return out;
}

function buildRule() {
  // When editing, start from the original rule so fields the form doesn't show
  // (cache_key, status_code_ttl, serve_stale, dynamic targets, …) survive.
  const base = form._orig ? JSON.parse(JSON.stringify(form._orig)) : {};
  for (const k of ['id', 'version', 'ref', 'last_updated']) delete base[k];
  const rule = { ...base };
  rule.description = form.description || undefined;
  rule.expression = form.expression.trim();
  rule.enabled = form.enabled;

  if (activeTab.value === 'cache') {
    rule.action = 'set_cache_settings';
    const ap = rule.action_parameters && typeof rule.action_parameters === 'object' ? { ...rule.action_parameters } : {};
    if (form.cacheBehavior === 'bypass') {
      ap.cache = false;
      delete ap.edge_ttl;
      delete ap.browser_ttl;
    } else {
      ap.cache = true;
      ap.edge_ttl = mergeTtl(ap.edge_ttl, form.edgeTtl);
      ap.browser_ttl = mergeTtl(ap.browser_ttl, form.browserTtl);
    }
    rule.action_parameters = ap;
  } else if (activeTab.value === 'redirect') {
    rule.action = 'redirect';
    const ap = rule.action_parameters && typeof rule.action_parameters === 'object' ? { ...rule.action_parameters } : {};
    const fv = ap.from_value && typeof ap.from_value === 'object' ? { ...ap.from_value } : {};
    const target = form.targetUrl.trim();
    // A full URL is a static target; anything else is treated as a CF expression.
    fv.target_url = /^https?:\/\//i.test(target) ? { value: target } : { expression: target };
    fv.status_code = Number(form.statusCode);
    fv.preserve_query_string = !!form.preserveQuery;
    ap.from_value = fv;
    rule.action_parameters = ap;
  } else {
    rule.action = 'rewrite';
    const headers = {};
    for (const op of form.headerOps) {
      const name = op.name.trim();
      if (!name) continue;
      if (op.operation === 'remove') headers[name] = { operation: 'remove' };
      else if (op.value) headers[name] = { operation: 'set', value: op.value };
      else if (op.expression) headers[name] = { operation: 'set', expression: op.expression };
      else headers[name] = { operation: 'set', value: '' };
    }
    rule.action_parameters = { headers };
  }
  return rule;
}

function applyForm() {
  if (!form.expression.trim()) return ElMessage.warning('请填写匹配表达式');
  if (activeTab.value === 'redirect' && !form.targetUrl.trim()) return ElMessage.warning('请填写目标 URL');
  if (activeTab.value === 'headers' && !form.headerOps.some((o) => o.name.trim())) {
    return ElMessage.warning('请至少填写一个响应头');
  }
  const rule = buildRule();
  if (editIndex.value >= 0) rules.value[editIndex.value] = rule;
  else rules.value.push(rule);
  dirty.value = true;
  dialogVisible.value = false;
}

function removeRule(idx) {
  rules.value.splice(idx, 1);
  dirty.value = true;
}
function move(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= rules.value.length) return;
  const a = rules.value;
  [a[idx], a[j]] = [a[j], a[idx]];
  dirty.value = true;
}
function addHeaderOp() {
  form.headerOps.push({ name: '', operation: 'set', value: '' });
}
function removeHeaderOp(i) {
  form.headerOps.splice(i, 1);
  if (!form.headerOps.length) form.headerOps.push({ name: '', operation: 'set', value: '' });
}

async function save() {
  saving.value = true;
  try {
    const r = await api.put(`api/rules/${currentPhase.value.phase}`, {
      accountId: accountId.value,
      zoneId: zoneId.value,
      zoneName: currentZone()?.name,
      rules: rules.value,
    });
    rules.value = r.rules || rules.value;
    dirty.value = false;
    ElMessage.success('已保存到 Cloudflare');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

function summary(rule) {
  const ap = rule.action_parameters || {};
  if (rule.action === 'set_cache_settings') {
    return ap.cache === false
      ? '绕过缓存'
      : `强制缓存(边缘 ${ttlLabel(ap.edge_ttl)} / 浏览器 ${ttlLabel(ap.browser_ttl)})`;
  }
  if (rule.action === 'redirect') {
    const fv = ap.from_value || {};
    return `${fv.status_code || 301} → ${fv.target_url?.value || ''}`;
  }
  if (rule.action === 'rewrite') {
    return Object.entries(ap.headers || {})
      .map(([k, v]) => `${v.operation === 'remove' ? '删除' : '设置'} ${k}`)
      .join('、');
  }
  return rule.action;
}
function ttlLabel(t) {
  if (!t || t.mode === 'respect_origin') return '遵循源站';
  return `${t.default ?? '?'} 秒`;
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
      @change="loadRules"
    >
      <el-option v-for="z in zones" :key="z.id" :label="z.name" :value="z.id" />
    </el-select>
    <div class="spacer"></div>
    <el-dropdown :disabled="!zoneId" @command="addTemplate">
      <el-button :disabled="!zoneId">
        常用规则<el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="(t, i) in currentTemplates" :key="i" :command="i">
            {{ t.label }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <el-button :disabled="!zoneId" @click="openAdd">
      <el-icon style="margin-right: 4px"><Plus /></el-icon>新增规则
    </el-button>
    <el-button type="primary" :disabled="!dirty" :loading="saving" @click="save">
      保存到 Cloudflare
    </el-button>
  </div>

  <el-radio-group
    :model-value="activeTab"
    style="margin-bottom: 12px"
    @change="confirmTabSwitch"
  >
    <el-radio-button v-for="p in PHASES" :key="p.key" :value="p.key">{{ p.label }}</el-radio-button>
  </el-radio-group>

  <el-alert type="info" :closable="false" style="margin-bottom: 12px">
    规则按 Cloudflare 表达式匹配,从上到下生效;改动在本地编辑,点「保存到 Cloudflare」整组写入。
    需 Token 具备相应规则权限。<span v-if="dirty" style="color: #e6a23c">有未保存改动。</span>
  </el-alert>

  <el-empty v-if="!zoneId" description="请选择账号与域名" />

  <el-table v-else v-loading="loading" :data="rules" border style="width: 100%">
    <el-table-column label="#" width="50">
      <template #default="{ $index }">{{ $index + 1 }}</template>
    </el-table-column>
    <el-table-column prop="description" label="描述" min-width="140" show-overflow-tooltip>
      <template #default="{ row }">{{ row.description || '—' }}</template>
    </el-table-column>
    <el-table-column prop="expression" label="表达式" min-width="240" show-overflow-tooltip />
    <el-table-column label="动作" min-width="220" show-overflow-tooltip>
      <template #default="{ row }">{{ summary(row) }}</template>
    </el-table-column>
    <el-table-column label="启用" width="70">
      <template #default="{ row }">
        <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
          {{ row.enabled === false ? '停用' : '启用' }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="180" fixed="right">
      <template #default="{ row, $index }">
        <el-button link @click="move($index, -1)" :disabled="$index === 0">↑</el-button>
        <el-button link @click="move($index, 1)" :disabled="$index === rules.length - 1">↓</el-button>
        <el-button type="primary" link @click="openEdit(row, $index)">编辑</el-button>
        <el-button type="danger" link @click="removeRule($index)">删除</el-button>
      </template>
    </el-table-column>
    <template #empty>该类型暂无规则</template>
  </el-table>

  <el-dialog
    v-model="dialogVisible"
    :title="editIndex >= 0 ? '编辑规则' : '新增规则'"
    width="600px"
  >
    <el-form label-width="92px">
      <el-form-item label="描述">
        <el-input v-model="form.description" placeholder="可选,便于识别" />
      </el-form-item>
      <el-form-item label="匹配表达式">
        <el-input v-model="form.expression" type="textarea" :rows="2" :placeholder="EXPR_HINT[activeTab]" />
      </el-form-item>

      <template v-if="activeTab === 'cache'">
        <el-form-item label="缓存行为">
          <el-radio-group v-model="form.cacheBehavior">
            <el-radio value="cache">强制缓存</el-radio>
            <el-radio value="bypass">绕过缓存</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.cacheBehavior === 'cache'" label="边缘缓存 TTL">
          <el-select v-model="form.edgeTtl" style="width: 220px">
            <el-option v-for="o in TTL_OPTS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.cacheBehavior === 'cache'" label="浏览器 TTL">
          <el-select v-model="form.browserTtl" style="width: 220px">
            <el-option v-for="o in TTL_OPTS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </template>

      <template v-else-if="activeTab === 'redirect'">
        <el-form-item label="目标 URL">
          <el-input v-model="form.targetUrl" placeholder="https://example.com/new 或动态表达式" />
        </el-form-item>
        <el-form-item label="状态码">
          <el-select v-model="form.statusCode" style="width: 160px">
            <el-option :label="'301 永久'" :value="301" />
            <el-option :label="'302 临时'" :value="302" />
            <el-option :label="'307'" :value="307" />
            <el-option :label="'308'" :value="308" />
          </el-select>
        </el-form-item>
        <el-form-item label="保留查询串">
          <el-switch v-model="form.preserveQuery" />
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label="响应头">
          <div style="width: 100%">
            <div
              v-for="(op, i) in form.headerOps"
              :key="i"
              style="display: flex; gap: 6px; margin-bottom: 6px"
            >
              <el-input v-model="op.name" placeholder="Header 名,如 X-Frame-Options" style="flex: 1" />
              <el-select v-model="op.operation" style="width: 96px">
                <el-option label="设置" value="set" />
                <el-option label="删除" value="remove" />
              </el-select>
              <el-input
                v-if="op.operation === 'set'"
                v-model="op.value"
                placeholder="值"
                style="flex: 1"
              />
              <el-button link type="danger" @click="removeHeaderOp(i)">×</el-button>
            </div>
            <el-button link type="primary" @click="addHeaderOp">+ 添加一项</el-button>
          </div>
        </el-form-item>
      </template>

      <el-form-item label="启用">
        <el-switch v-model="form.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" @click="applyForm">确定</el-button>
    </template>
  </el-dialog>
</template>
