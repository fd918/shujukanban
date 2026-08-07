const { client } = require('./larkClient');
const { readJson, writeJson } = require('./store');

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

async function getUserContactByOpenId(openId) {
  const res = await client.contact.user.get({
    path: {
      user_id: openId,
    },
    params: {
      user_id_type: 'open_id',
    },
  });
  if (res.code !== 0) {
    throw new Error(`获取飞书用户通讯录信息失败：${res.code} ${res.msg}`);
  }
  return res.data?.user || null;
}

async function verifyMailboxBelongsToUser(openId, mailboxId) {
  const user = await getUserContactByOpenId(openId);
  const allowedEmails = [
    user?.enterprise_email,
    user?.email,
  ].map(normalizeEmail).filter(Boolean);
  return {
    ok: allowedEmails.includes(normalizeEmail(mailboxId)),
    user,
    allowedEmails,
  };
}

async function listAllDepartmentIds() {
  const ids = ['0'];
  const res = await client.contact.department.children({
    path: { department_id: '0' },
    params: {
      department_id_type: 'open_department_id',
      fetch_child: true,
      page_size: 50,
    },
  });
  if (res.code !== 0) {
    throw new Error(`获取飞书部门列表失败：${res.code} ${res.msg}`);
  }
  for (const item of res.data?.items || []) {
    const id = item.open_department_id || item.department_id;
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

async function listDepartmentUsers(departmentId) {
  const users = [];
  let pageToken = undefined;
  for (let page = 0; page < 50; page += 1) {
    const res = await client.contact.user.findByDepartment({
      params: {
        department_id: departmentId,
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) {
      throw new Error(`获取飞书部门用户失败：${res.code} ${res.msg}`);
    }
    users.push(...(res.data?.items || []));
    if (!res.data?.has_more || !res.data?.page_token) break;
    pageToken = res.data.page_token;
  }
  return users;
}

function normalizeName(name) {
  return (name || '').replace(/\s+/g, '').trim();
}

async function buildContactCache({ force = false } = {}) {
  const cached = readJson('contact-cache.json', {});
  const updatedAt = cached.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
  if (!force && cached.users?.length && Date.now() - updatedAt < 24 * 60 * 60 * 1000) {
    return cached;
  }

  const byEmail = new Map();
  for (const departmentId of await listAllDepartmentIds()) {
    for (const user of await listDepartmentUsers(departmentId)) {
      const email = user.enterprise_email || user.email;
      if (!email) continue;
      byEmail.set(normalizeEmail(email), {
        name: user.name || '',
        email,
        enterprise_email: user.enterprise_email || '',
        open_id: user.open_id || '',
        user_id: user.user_id || '',
      });
    }
  }

  const data = {
    updatedAt: new Date().toISOString(),
    users: [...byEmail.values()],
  };
  writeJson('contact-cache.json', data);
  return data;
}

async function findUsersByName(name) {
  const normalized = normalizeName(name.replace(/^@/, ''));
  if (!normalized) return [];
  const cache = await buildContactCache();
  return (cache.users || []).filter((user) => normalizeName(user.name) === normalized);
}

module.exports = {
  normalizeEmail,
  getUserContactByOpenId,
  verifyMailboxBelongsToUser,
  buildContactCache,
  findUsersByName,
};
