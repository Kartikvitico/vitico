/* BillZilla App Core v4 */
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
 ? 'http://127.0.0.1:8787/api/v1'
 : '/api/v1';

function getToken() {
 const isOwner = window.location.pathname.indexOf('owner') > -1;
 return localStorage.getItem(isOwner ? 'owner_token' : 'token');
}

function getUser() {
 const isOwner = window.location.pathname.indexOf('owner') > -1;
 try { return JSON.parse(localStorage.getItem(isOwner ? 'owner' : 'user')); } catch { return null; }
}

function authFetch(url, opts) {
 opts = opts || {};
 const token = getToken();

 // If no token and not on login page, redirect to login
 if (!token) {
   const path = window.location.pathname;
   const isLoginPage = path === '/' || path.indexOf('index.html') > -1 || path.indexOf('owner-login') > -1;
   if (!isLoginPage) {
     localStorage.clear();
     window.location.href = '/';
     return Promise.reject(new Error('No token'));
   }
 }

 const fullUrl = url.startsWith('http') ? url : API_BASE + url;
 return fetch(fullUrl, {
 ...opts,
 headers: {
 'Content-Type': 'application/json',
 'Authorization': 'Bearer ' + (token || ''),
 ...(opts.headers || {})
 }
 }).then(res => {
   // Auto-redirect on 401 Unauthorized
   if (res.status === 401) {
     localStorage.clear();
     window.location.href = '/';
     return Promise.reject(new Error('Session expired'));
   }
   return res;
 });
}

function formatCurrency(amount, currency) {
 currency = currency || 'FJD';
 return new Intl.NumberFormat('en-FJ', { style: 'currency', currency }).format(amount || 0);
}

function formatDate(dateStr) {
 if (!dateStr) return '-';
 return new Date(dateStr).toLocaleDateString('en-GB');
}

function formatNumber(num) {
 return new Intl.NumberFormat('en-FJ').format(num || 0);
}

/* ---------- THEME ---------- */
function toggleTheme() {
 const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
 if (isDark) {
 document.documentElement.removeAttribute('data-theme');
 localStorage.setItem('theme', 'light');
 } else {
 document.documentElement.setAttribute('data-theme', 'dark');
 localStorage.setItem('theme', 'dark');
 }
 updateThemeIcon();
}

function updateThemeIcon() {
 const btn = document.getElementById('theme-toggle');
 if (!btn) return;
 const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
 btn.innerHTML = isDark
 ? '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
 : '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
}

/* ---------- SIDEBAR ---------- */
function highlightSidebar(activePage) {
 var nav = document.querySelector('.sidebar nav');
 if (!nav) return;
 var links = nav.querySelectorAll('a');
 links.forEach(function(a) {
 var pageKey = a.getAttribute('data-page');
 if (pageKey === activePage) {
 a.classList.add('active');
 } else {
 a.classList.remove('active');
 }
 });
}

function filterSidebarByRole() {
 var user = getUser();
 var settingsLink = document.querySelector('.sidebar nav a[data-page="settings"]');
 if (settingsLink) {
 if (user && user.role === 'admin') {
 settingsLink.style.display = '';
 } else {
 settingsLink.style.display = 'none';
 }
 }
}

function initLayout(activePage) {
 var user = getUser();
 var path = window.location.pathname;
 var isLoginPage = path === '/' || path.indexOf('index.html') > -1 || path.indexOf('owner-login') > -1;

 if (!user && !isLoginPage) {
 window.location.href = '/';
 return;
 }

 highlightSidebar(activePage);
 filterSidebarByRole();

 var userEl = document.getElementById('current-user');
 if (userEl && user) {
 userEl.textContent = (user.first_name || '') + ' ' + (user.last_name || '');
 }

 var themeBtn = document.getElementById('theme-toggle');
 if (themeBtn) {
 updateThemeIcon();
 themeBtn.addEventListener('click', toggleTheme);
 }

 var saved = localStorage.getItem('theme');
 if (saved === 'dark') {
 document.documentElement.setAttribute('data-theme', 'dark');
 updateThemeIcon();
 }
}

/* ---------- GLOBAL EVENTS ---------- */
document.addEventListener('DOMContentLoaded', function() {
 var logoutBtn = document.getElementById('logout-btn');
 if (logoutBtn) {
 logoutBtn.addEventListener('click', async function() {
 await authFetch('/auth/logout', { method: 'POST' });
 localStorage.clear();
 window.location.href = '/';
 });
 }

 var searchInput = document.getElementById('global-search');
 if (searchInput) {
 var timeout;
 searchInput.addEventListener('input', function() {
 clearTimeout(timeout);
 var q = searchInput.value;
 var results = document.getElementById('search-results');
 if (!results) return;
 if (q.length < 2) { results.style.display = 'none'; return; }
 timeout = setTimeout(async function() {
 try {
 var res = await authFetch('/search?q=' + encodeURIComponent(q));
 var json = await res.json();
 results.innerHTML = (json.data || []).map(function(r) {
 var url = r.type === 'invoice' ? '/invoice-detail.html?id=' + r.id : '/customer-detail.html?id=' + r.id;
 return '<a href="' + url + '"><strong>' + r.name + '</strong><br><small>' + r.type + '</small></a>';
 }).join('');
 results.style.display = (json.data && json.data.length) ? 'block' : 'none';
 } catch(e) {}
 }, 200);
 });
 document.addEventListener('click', function(e) {
 var results = document.getElementById('search-results');
 if (results && !searchInput.contains(e.target) && !results.contains(e.target)) {
 results.style.display = 'none';
 }
 });
 }
});

/* ---------- AUTO-INIT ---------- */
(function() {
 var path = window.location.pathname;
 var pageMap = {
 '/dashboard.html': 'dashboard',
 '/invoices.html': 'invoices',
 '/invoice-create.html': 'invoices',
 '/invoice-detail.html': 'invoices',
 '/customers.html': 'customers',
 '/customer-create.html': 'customers',
 '/customer-detail.html': 'customers',
 '/products.html': 'products',
 '/product-create.html': 'products',
 '/product-detail.html': 'products',
 '/approvals.html': 'approvals',
 '/reports.html': 'reports',
 '/audit.html': 'audit',
 '/settings.html': 'settings',
 '/owner-payments.html': 'payments'
 };
 var activePage = pageMap[path];
 if (activePage) {
 if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', function() { initLayout(activePage); });
 } else {
 initLayout(activePage);
 }
 }
})();
