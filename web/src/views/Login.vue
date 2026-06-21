<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../store/auth';

const store = useAppStore();
const router = useRouter();
const form = ref({ username: '', password: '', code: '' });
const needCode = ref(false);
const loading = ref(false);

async function submit() {
  loading.value = true;
  try {
    await store.login(form.value.username, form.value.password, needCode.value ? form.value.code : undefined);
    router.push({ name: 'records' });
  } catch (e) {
    if (e.data?.error === 'totp_required') {
      needCode.value = true;
      ElMessage.info('该账号已开启两步验证,请输入验证码');
    } else {
      if (e.data?.error === 'totp_invalid') form.value.code = '';
      ElMessage.error(e.message);
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap">
    <el-card class="auth-card">
      <h1>☁️ Cloudflare DNS 面板</h1>
      <div class="sub">请登录</div>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" autocomplete="username" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item v-if="needCode" label="两步验证码">
          <el-input
            v-model="form.code"
            placeholder="身份验证器 App 的 6 位码"
            maxlength="6"
            autocomplete="one-time-code"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button type="primary" :loading="loading" style="width: 100%" @click="submit">登录</el-button>
      </el-form>
    </el-card>
  </div>
</template>
