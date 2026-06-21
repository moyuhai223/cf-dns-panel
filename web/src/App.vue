<script setup>
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
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
</script>

<template>
  <router-view v-if="!store.authenticated" />

  <el-container v-else style="height: 100%">
    <el-header height="56px" class="app-header">
      <div class="left">
        <span class="brand">☁️ Cloudflare DNS</span>
        <el-menu :default-active="activeMenu" mode="horizontal" router :ellipsis="false">
          <el-menu-item index="records" :route="{ name: 'records' }">记录管理</el-menu-item>
          <el-menu-item index="accounts" :route="{ name: 'accounts' }">账号 / Token</el-menu-item>
          <el-menu-item index="audit" :route="{ name: 'audit' }">审计日志</el-menu-item>
        </el-menu>
      </div>
      <el-dropdown @command="(c) => (c === 'logout' ? onLogout() : openPw())">
        <span style="cursor: pointer">
          <el-icon><User /></el-icon>
          {{ store.username }}
          <el-icon><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="password">修改密码</el-dropdown-item>
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
</template>
