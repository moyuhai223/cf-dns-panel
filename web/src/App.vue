<script setup>
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useAppStore } from './store/auth';
import { api } from './api';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const activeMenu = computed(() => route.name);

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
    <el-header height="56px" class="app-header">
      <div class="left">
        <span class="brand">☁️ Cloudflare DNS</span>
        <el-menu :default-active="activeMenu" mode="horizontal" router :ellipsis="false">
          <el-menu-item index="records" :route="{ name: 'records' }">记录管理</el-menu-item>
          <el-menu-item index="accounts" :route="{ name: 'accounts' }">账号 / Token</el-menu-item>
          <el-menu-item index="ddns" :route="{ name: 'ddns' }">DDNS</el-menu-item>
          <el-menu-item index="cache" :route="{ name: 'cache' }">缓存</el-menu-item>
          <el-menu-item index="rules" :route="{ name: 'rules' }">规则</el-menu-item>
          <el-menu-item index="audit" :route="{ name: 'audit' }">审计日志</el-menu-item>
        </el-menu>
      </div>
      <el-dropdown @command="onCommand">
        <span style="cursor: pointer">
          <el-icon><User /></el-icon>
          {{ store.username }}
          <el-icon><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="password">修改密码</el-dropdown-item>
            <el-dropdown-item command="2fa">
              两步验证<span v-if="store.twoFactor" style="color: #67c23a"> ·已开启</span>
            </el-dropdown-item>
            <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-header>

    <el-main>
      <div class="content">
        <router-view />
      </div>
    </el-main>
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
  </el-config-provider>
</template>
