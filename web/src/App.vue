<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import {
  Document,
  Search,
  Key,
  Refresh,
  MagicStick,
  Operation,
  Tickets,
  User,
  ArrowDown,
  Moon,
  Sunny,
  Fold,
  Expand,
} from '@element-plus/icons-vue';
import { useAppStore } from './store/auth';
import { api } from './api';
import { isDark, toggleTheme } from './theme';
import CloudLogo from './components/CloudLogo.vue';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const activeMenu = computed(() => route.name);
const isCollapse = ref(false);

const NAV = [
  { name: 'records', label: '记录管理', icon: Document },
  { name: 'search', label: '全局搜索', icon: Search },
  { name: 'accounts', label: '账号 / Token', icon: Key },
  { name: 'ddns', label: 'DDNS', icon: Refresh },
  { name: 'cache', label: '缓存', icon: MagicStick },
  { name: 'rules', label: '规则', icon: Operation },
  { name: 'audit', label: '审计日志', icon: Tickets },
];
const pageTitle = computed(() => NAV.find((n) => n.name === route.name)?.label || '');

// Auto-collapse the sidebar to icons on narrow screens.
function onResize() {
  isCollapse.value = window.innerWidth < 768;
}
onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));

async function onLogout() {
  await store.logout();
  router.push({ name: 'login' });
}

// change-password dialog
const pwVisible = ref(false);
const pwForm = ref({ oldPassword: '', newPassword: '', confirm: '' });
const pwSaving = ref(false);

function openPw() {
  pwForm.value = { oldPassword: '', newPassword: '', confirm: '' };
  pwVisible.value = true;
}

async function savePw() {
  if (pwForm.value.newPassword.length < 8) return ElMessage.warning('新密码至少 8 位');
  if (pwForm.value.newPassword !== pwForm.value.confirm) return ElMessage.warning('两次输入不一致');
  pwSaving.value = true;
  try {
    await api.post('api/auth/change-password', {
      oldPassword: pwForm.value.oldPassword,
      newPassword: pwForm.value.newPassword,
    });
    ElMessage.success('密码已修改');
    pwVisible.value = false;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    pwSaving.value = false;
  }
}

function onCommand(c) {
  if (c === 'logout') onLogout();
  else if (c === 'password') openPw();
  else if (c === '2fa') open2fa();
  else if (c === 'notify') openNotify();
}

// notification settings dialog
const notifyVisible = ref(false);
const notifyBusy = ref(false);
const notifyForm = ref({
  enabled: false,
  webhookUrl: '',
  telegramToken: '',
  telegramChat: '',
  telegramTokenSet: false,
  events: { create: true, update: true, delete: true, batch: true, ddns: false },
});

async function openNotify() {
  notifyVisible.value = true;
  try {
    const r = await api.get('api/settings/notifications');
    notifyForm.value = { telegramToken: '', ...r.config };
  } catch (e) {
    ElMessage.error(e.message);
  }
}
async function saveNotify(close = true) {
  notifyBusy.value = true;
  try {
    await api.put('api/settings/notifications', notifyForm.value);
    notifyForm.value.telegramTokenSet = notifyForm.value.telegramTokenSet || !!notifyForm.value.telegramToken;
    notifyForm.value.telegramToken = '';
    if (close) {
      ElMessage.success('已保存');
      notifyVisible.value = false;
    }
  } catch (e) {
    ElMessage.error(e.message);
    throw e;
  } finally {
    notifyBusy.value = false;
  }
}
async function testNotify() {
  try {
    await saveNotify(false); // persist current form first, then test it
  } catch {
    return;
  }
  notifyBusy.value = true;
  try {
    const r = await api.post('api/settings/notifications/test');
    const results = r.results || [];
    if (results.length && results.every((x) => x.ok)) ElMessage.success('测试已发送');
    else if (results.some((x) => x.ok)) ElMessage.warning('部分发送成功,请检查另一个渠道');
    else ElMessage.error('发送失败,请检查配置');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    notifyBusy.value = false;
  }
}

// two-factor dialog
const twofaVisible = ref(false);
const twofaMode = ref('intro'); // intro | setup
const twofaSecret = ref('');
const twofaQr = ref('');
const twofaCode = ref('');
const twofaPassword = ref('');
const twofaBusy = ref(false);

function open2fa() {
  twofaMode.value = 'intro';
  twofaSecret.value = '';
  twofaQr.value = '';
  twofaCode.value = '';
  twofaPassword.value = '';
  twofaVisible.value = true;
}

async function start2fa() {
  twofaBusy.value = true;
  try {
    const r = await api.post('api/auth/2fa/setup');
    twofaSecret.value = r.secret;
    const QR = await import('qrcode'); // code-split: only loaded when setting up 2FA
    twofaQr.value = await QR.default.toDataURL(r.uri, { margin: 1, width: 200 });
    twofaMode.value = 'setup';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    twofaBusy.value = false;
  }
}

async function enable2fa() {
  twofaBusy.value = true;
  try {
    await api.post('api/auth/2fa/enable', { code: twofaCode.value });
    store.twoFactor = true;
    ElMessage.success('两步验证已开启');
    twofaVisible.value = false;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    twofaBusy.value = false;
  }
}

async function disable2fa() {
  twofaBusy.value = true;
  try {
    await api.post('api/auth/2fa/disable', {
      password: twofaPassword.value,
      code: twofaCode.value,
    });
    store.twoFactor = false;
    ElMessage.success('两步验证已关闭');
    twofaVisible.value = false;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    twofaBusy.value = false;
  }
}
</script>

<template>
  <el-config-provider :locale="zhCn">
  <router-view v-if="!store.authenticated" />

  <el-container v-else style="height: 100%">
    <el-aside :width="isCollapse ? '64px' : 'var(--sidebar-width)'" class="app-aside">
      <div class="app-brand">
        <CloudLogo class="logo" :size="24" />
        <span v-show="!isCollapse">CF DNS 面板</span>
      </div>
      <el-menu :default-active="activeMenu" :collapse="isCollapse" router>
        <el-menu-item v-for="n in NAV" :key="n.name" :index="n.name" :route="{ name: n.name }">
          <el-icon><component :is="n.icon" /></el-icon>
          <template #title>{{ n.label }}</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header height="56px" class="app-header">
        <div class="left">
          <el-icon class="icon-btn" @click="isCollapse = !isCollapse">
            <Fold v-if="!isCollapse" />
            <Expand v-else />
          </el-icon>
          <span class="page-title">{{ pageTitle }}</span>
        </div>
        <div class="right">
          <el-tooltip :content="isDark ? '切换到亮色' : '切换到暗色'" placement="bottom">
            <el-icon class="icon-btn" @click="toggleTheme">
              <Moon v-if="!isDark" />
              <Sunny v-else />
            </el-icon>
          </el-tooltip>
          <el-dropdown @command="onCommand">
            <span class="app-user">
              <el-icon><User /></el-icon>
              {{ store.username }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password">修改密码</el-dropdown-item>
                <el-dropdown-item command="2fa">
                  两步验证<span v-if="store.twoFactor" style="color: var(--el-color-success)"> ·已开启</span>
                </el-dropdown-item>
                <el-dropdown-item command="notify">通知设置</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main>
        <div class="content">
          <router-view />
        </div>
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="pwVisible" title="修改密码" width="420px">
    <el-form label-width="80px">
      <el-form-item label="原密码">
        <el-input v-model="pwForm.oldPassword" type="password" show-password />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="pwForm.newPassword" type="password" show-password />
      </el-form-item>
      <el-form-item label="确认">
        <el-input v-model="pwForm.confirm" type="password" show-password />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwVisible = false">取消</el-button>
      <el-button type="primary" :loading="pwSaving" @click="savePw">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="twofaVisible" title="两步验证 (2FA)" width="420px">
    <div v-if="store.twoFactor">
      <p>两步验证已<b style="color: #67c23a">开启</b>。关闭需验证密码与当前验证码。</p>
      <el-form label-width="84px">
        <el-form-item label="密码">
          <el-input v-model="twofaPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="验证码">
          <el-input v-model="twofaCode" maxlength="6" placeholder="当前 6 位码" />
        </el-form-item>
      </el-form>
    </div>

    <div v-else-if="twofaMode === 'setup'">
      <p>用身份验证器 App(Google Authenticator / 1Password / Authy 等)扫码,或手动输入密钥:</p>
      <div style="text-align: center">
        <img :src="twofaQr" alt="TOTP QR" style="width: 200px; height: 200px" />
      </div>
      <p class="muted" style="word-break: break-all; text-align: center">密钥:{{ twofaSecret }}</p>
      <el-form label-width="84px">
        <el-form-item label="验证码">
          <el-input
            v-model="twofaCode"
            maxlength="6"
            placeholder="输入 App 显示的 6 位码"
            @keyup.enter="enable2fa"
          />
        </el-form-item>
      </el-form>
    </div>

    <div v-else>
      <p>开启后,登录除密码外还需身份验证器 App 的 6 位动态码,账号更安全。</p>
    </div>

    <template #footer>
      <el-button @click="twofaVisible = false">取消</el-button>
      <el-button v-if="store.twoFactor" type="danger" :loading="twofaBusy" @click="disable2fa">
        关闭两步验证
      </el-button>
      <el-button v-else-if="twofaMode === 'setup'" type="primary" :loading="twofaBusy" @click="enable2fa">
        启用
      </el-button>
      <el-button v-else type="primary" :loading="twofaBusy" @click="start2fa">开始设置</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="notifyVisible" title="变更通知" width="520px">
    <el-form label-width="118px">
      <el-form-item label="启用通知">
        <el-switch v-model="notifyForm.enabled" />
      </el-form-item>
      <el-form-item label="Webhook URL">
        <el-input v-model="notifyForm.webhookUrl" placeholder="变更时 POST JSON 到此地址(可留空)" />
      </el-form-item>
      <el-form-item label="Telegram Token">
        <el-input
          v-model="notifyForm.telegramToken"
          type="password"
          show-password
          :placeholder="notifyForm.telegramTokenSet ? '已设置,留空保持不变' : 'Bot Token(可留空)'"
        />
      </el-form-item>
      <el-form-item label="Telegram Chat">
        <el-input v-model="notifyForm.telegramChat" placeholder="chat_id(配合上面的 Token)" />
      </el-form-item>
      <el-form-item label="通知事件">
        <el-checkbox v-model="notifyForm.events.create">新增</el-checkbox>
        <el-checkbox v-model="notifyForm.events.update">修改</el-checkbox>
        <el-checkbox v-model="notifyForm.events.delete">删除</el-checkbox>
        <el-checkbox v-model="notifyForm.events.batch">批量/导入</el-checkbox>
        <el-checkbox v-model="notifyForm.events.ddns">DDNS</el-checkbox>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="notifyVisible = false">取消</el-button>
      <el-button :loading="notifyBusy" @click="testNotify">保存并测试</el-button>
      <el-button type="primary" :loading="notifyBusy" @click="saveNotify">保存</el-button>
    </template>
  </el-dialog>
  </el-config-provider>
</template>
