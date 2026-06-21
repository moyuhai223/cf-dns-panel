<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../store/auth';

const store = useAppStore();
const router = useRouter();
const form = ref({ username: 'admin', password: '', confirm: '' });
const loading = ref(false);

async function submit() {
  if (!form.value.username) return ElMessage.warning('请输入用户名');
  if (form.value.password.length < 8) return ElMessage.warning('密码至少 8 位');
  if (form.value.password !== form.value.confirm) return ElMessage.warning('两次输入不一致');
  loading.value = true;
  try {
    await store.setup(form.value.username, form.value.password);
    router.push({ name: 'records' });
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap">
    <el-card class="auth-card">
      <h1>初始化管理员</h1>
      <div class="sub">首次使用,请设置管理员账号</div>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码(至少 8 位)">
          <el-input v-model="form.password" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="form.confirm" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-button type="primary" :loading="loading" style="width: 100%" @click="submit">
          创建并登录
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>
