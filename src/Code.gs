/**
 * Renew Group – Recruitment Tracker
 * Google Apps Script backend. Data is stored in the Google Sheet this script is bound to
 * (or the sheet whose ID is saved in Script Properties as SPREADSHEET_ID).
 *
 * Roles
 *   Admin – everything, incl. branches, users and serial numbers
 *   HR    – sees all branches, updates status / candidates / interview dates, edits serial numbers
 *   Head  – raises position requests for their own branch(es) and tracks progress
 */

const APP_NAME = 'Renew Group Recruitment Tracker';
const SESSION_SECONDS = 6 * 60 * 60; // CacheService maximum (6 h)
const DEFAULT_ADMIN_PASSWORD = 'Admin@123';

const SCHEMA = {
  Branches: ['Code', 'Name', 'Location', 'NextSerial', 'Active', 'CreatedAt'],
  Users: ['Email', 'Name', 'Role', 'Branch', 'PasswordHash', 'Salt', 'Active', 'MustChange', 'CreatedAt'],
  Requests: ['ID', 'SerialNo', 'Branch', 'Position', 'Department', 'Vacancies', 'Priority', 'Experience',
    'Qualification', 'SalaryRange', 'Description', 'RequiredBy', 'Status', 'HRRemarks', 'RequestedBy',
    'RequestedByName', 'RequestedAt', 'UpdatedBy', 'UpdatedAt', 'ClosedAt'],
  Candidates: ['ID', 'RequestID', 'Name', 'Phone', 'Email', 'InterviewDate', 'InterviewTime', 'Mode',
    'Interviewer', 'Stage', 'Remarks', 'UpdatedBy', 'UpdatedAt'],
  History: ['At', 'RequestID', 'SerialNo', 'User', 'Action', 'Details']
};

const ROLES = ['Admin', 'HR', 'Head'];
const PRIORITIES = ['Urgent', 'Top Priority', 'Need'];
const STATUSES = ['Requested', 'Sourcing Profiles', 'Interview Scheduled', 'Selected', 'Offer Released',
  'Joined', 'On Hold', 'Cancelled'];
const CLOSED_STATUSES = ['Joined', 'Cancelled'];
const STAGES = ['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Rejected', 'No Show',
  'Offer Released', 'Joined', 'Declined'];
const MODES = ['In person', 'Phone', 'Video call'];

const HEAD_FIELDS = ['Position', 'Department', 'Vacancies', 'Priority', 'Experience', 'Qualification',
  'SalaryRange', 'Description', 'RequiredBy'];
const HR_FIELDS = HEAD_FIELDS.concat(['SerialNo', 'Branch', 'Status', 'HRRemarks']);
const CANDIDATE_FIELDS = ['Name', 'Phone', 'Email', 'InterviewDate', 'InterviewTime', 'Mode', 'Interviewer',
  'Stage', 'Remarks'];

/* ------------------------------------------------------------------ web app */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Recruitment Tracker')
      .addItem('Run setup / repair sheets', 'setup')
      .addToUi();
  } catch (e) { /* not opened from a spreadsheet */ }
}

/**
 * Run once from the Apps Script editor (or the sheet menu).
 * Creates the sheets and a first Admin login: <your Google email> / Admin@123
 */
function setup() {
  const ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SCHEMA[name];
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0d4a3a').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, headers.length).setNumberFormat('@');
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  if (!readAll_('Users').length) {
    const email = (Session.getEffectiveUser().getEmail() || 'admin@renewgroups.com').toLowerCase();
    createUser_({ Email: email, Name: 'Administrator', Role: 'Admin', Branch: '', Password: DEFAULT_ADMIN_PASSWORD });
    Logger.log('Admin login created: ' + email + ' / ' + DEFAULT_ADMIN_PASSWORD + ' (you will be asked to change it)');
  }
  return 'Setup complete';
}

/* ------------------------------------------------------------------ public endpoints */

function login(email, password) {
  try {
    email = String(email || '').trim().toLowerCase();
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + email;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= 5) throw new Error('Too many attempts. Try again in 15 minutes.');
    const u = readAll_('Users').find(function (x) { return String(x.Email).toLowerCase() === email; });
    if (!u || !isTrue_(u.Active) || hash_(password, u.Salt) !== u.PasswordHash) {
      cache.put(failKey, String(fails + 1), 900);
      throw new Error('Invalid email or password.');
    }
    cache.remove(failKey);
    const token = Utilities.getUuid();
    cache.put('s_' + token, email, SESSION_SECONDS);
    return { ok: true, data: { token: token } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function logout(token) {
  CacheService.getScriptCache().remove('s_' + token);
  return { ok: true };
}

/** Single entry point used by the front end: api(token, action, payload). */
function api(token, action, payload) {
  try {
    const user = session_(token);
    const fn = ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    return { ok: true, data: fn(user, payload || {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const ACTIONS = {
  bootstrap: bootstrap_,
  createRequest: createRequest_,
  updateRequest: updateRequest_,
  deleteRequest: deleteRequest_,
  saveCandidate: saveCandidate_,
  deleteCandidate: deleteCandidate_,
  getHistory: getHistory_,
  changePassword: changePassword_,
  listUsers: listUsers_,
  saveUser: saveUser_,
  saveBranch: saveBranch_
};

/* ------------------------------------------------------------------ actions */

function bootstrap_(user) {
  const requests = visibleRequests_(user);
  const ids = {};
  requests.forEach(function (r) { ids[r.ID] = true; });
  const candidates = readAll_('Candidates').filter(function (c) { return ids[c.RequestID]; });
  return {
    user: publicUser_(user),
    config: { appName: APP_NAME, roles: ROLES, priorities: PRIORITIES, statuses: STATUSES,
      closedStatuses: CLOSED_STATUSES, stages: STAGES, modes: MODES, today: today_() },
    branches: readAll_('Branches').map(clean_),
    requests: requests.map(clean_),
    candidates: candidates.map(clean_)
  };
}

function createRequest_(user, p) {
  const branchCode = String(p.Branch || '').trim().toUpperCase();
  if (user.Role === 'Head' && userBranches_(user).indexOf(branchCode) < 0) throw new Error('You can only raise requests for your own branch.');
  required_(p, ['Position', 'Priority']);
  if (PRIORITIES.indexOf(p.Priority) < 0) throw new Error('Invalid priority.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const branch = readAll_('Branches').find(function (b) { return b.Code === branchCode && isTrue_(b.Active); });
    if (!branch) throw new Error('Select a valid, active branch.');
    const existing = readAll_('Requests').map(function (r) { return String(r.SerialNo).toUpperCase(); });
    let n = Math.max(1, parseInt(branch.NextSerial, 10) || 1);
    let serial = makeSerial_(branch.Code, n);
    while (existing.indexOf(serial.toUpperCase()) >= 0) serial = makeSerial_(branch.Code, ++n);
    branch.NextSerial = n + 1;
    write_('Branches', branch._row, branch);

    const now = now_();
    const req = { ID: Utilities.getUuid(), SerialNo: serial, Branch: branch.Code, Status: 'Requested',
      RequestedBy: user.Email, RequestedByName: user.Name, RequestedAt: now, UpdatedBy: user.Name, UpdatedAt: now };
    HEAD_FIELDS.forEach(function (k) { if (p[k] !== undefined) req[k] = String(p[k]).trim(); });
    req.Vacancies = Math.max(1, parseInt(req.Vacancies, 10) || 1);
    write_('Requests', null, req);
    log_(req, user, 'Created', req.Position + ' · ' + req.Priority + ' · ' + req.Vacancies + ' vacancy(ies)');
    return { id: req.ID, serial: serial };
  } finally {
    lock.releaseLock();
  }
}

function updateRequest_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const all = readAll_('Requests');
    const req = all.find(function (r) { return r.ID === p.ID; });
    if (!req || !canSee_(user, req)) throw new Error('Request not found.');
    const isHR = user.Role === 'HR' || user.Role === 'Admin';
    if (!isHR && CLOSED_STATUSES.indexOf(req.Status) >= 0) throw new Error('This request is closed and can no longer be edited.');
    const fields = isHR ? HR_FIELDS : HEAD_FIELDS;

    if (p.Priority !== undefined && PRIORITIES.indexOf(p.Priority) < 0) throw new Error('Invalid priority.');
    if (isHR && p.Status !== undefined && STATUSES.indexOf(p.Status) < 0) throw new Error('Invalid status.');
    if (isHR && p.SerialNo !== undefined) {
      const s = String(p.SerialNo).trim().toUpperCase();
      if (!s) throw new Error('Serial number cannot be empty.');
      if (all.some(function (r) { return r.ID !== req.ID && String(r.SerialNo).toUpperCase() === s; })) {
        throw new Error('Serial number ' + s + ' is already used.');
      }
      p.SerialNo = s;
    }
    if (isHR && p.Branch !== undefined) {
      p.Branch = String(p.Branch).trim().toUpperCase();
      if (!readAll_('Branches').some(function (b) { return b.Code === p.Branch; })) throw new Error('Unknown branch.');
    }
    if (p.Vacancies !== undefined) p.Vacancies = Math.max(1, parseInt(p.Vacancies, 10) || 1);

    const changes = [];
    fields.forEach(function (k) {
      if (p[k] === undefined) return;
      const nv = String(p[k]).trim();
      if (nv !== String(req[k])) {
        changes.push(k + ': ' + (req[k] === '' ? '—' : req[k]) + ' → ' + (nv === '' ? '—' : nv));
        req[k] = nv;
      }
    });
    if (!changes.length) return { changed: false };
    if (CLOSED_STATUSES.indexOf(req.Status) >= 0) { if (!req.ClosedAt) req.ClosedAt = now_(); }
    else req.ClosedAt = '';
    req.UpdatedBy = user.Name;
    req.UpdatedAt = now_();
    write_('Requests', req._row, req);
    log_(req, user, 'Updated', changes.join('; '));
    return { changed: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteRequest_(user, p) {
  requireRole_(user, ['Admin']);
  const req = readAll_('Requests').find(function (r) { return r.ID === p.ID; });
  if (!req) throw new Error('Request not found.');
  const cands = readAll_('Candidates').filter(function (c) { return c.RequestID === req.ID; });
  deleteRows_('Candidates', cands.map(function (c) { return c._row; }));
  deleteRows_('Requests', [req._row]);
  log_(req, user, 'Deleted', req.Position);
  return true;
}

function saveCandidate_(user, p) {
  requireRole_(user, ['Admin', 'HR']);
  required_(p, ['RequestID', 'Name']);
  if (p.Stage && STAGES.indexOf(p.Stage) < 0) throw new Error('Invalid stage.');
  if (p.InterviewDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.InterviewDate)) throw new Error('Interview date must be YYYY-MM-DD.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = readAll_('Requests').find(function (r) { return r.ID === p.RequestID; });
    if (!req) throw new Error('Request not found.');
    let cand;
    let action;
    if (p.ID) {
      cand = readAll_('Candidates').find(function (c) { return c.ID === p.ID; });
      if (!cand) throw new Error('Candidate not found.');
      action = 'Candidate updated';
    } else {
      cand = { ID: Utilities.getUuid(), RequestID: req.ID, _row: null };
      action = 'Candidate added';
    }
    CANDIDATE_FIELDS.forEach(function (k) { if (p[k] !== undefined) cand[k] = String(p[k]).trim(); });
    if (!cand.Stage) cand.Stage = cand.InterviewDate ? 'Interview Scheduled' : 'Shortlisted';
    cand.UpdatedBy = user.Name;
    cand.UpdatedAt = now_();
    write_('Candidates', cand._row, cand);
    log_(req, user, action, cand.Name + ' · ' + cand.Stage + (cand.InterviewDate ? ' · ' + cand.InterviewDate + ' ' + (cand.InterviewTime || '') : ''));

    // Move the request forward automatically when it makes sense
    const auto = autoStatus_(req.Status, cand.Stage, cand.InterviewDate);
    if (auto && auto !== req.Status) {
      const old = req.Status;
      req.Status = auto;
      req.ClosedAt = CLOSED_STATUSES.indexOf(auto) >= 0 ? now_() : '';
      req.UpdatedBy = user.Name;
      req.UpdatedAt = now_();
      write_('Requests', req._row, req);
      log_(req, user, 'Updated', 'Status: ' + old + ' → ' + auto + ' (auto)');
    }
    return { id: cand.ID };
  } finally {
    lock.releaseLock();
  }
}

function autoStatus_(current, stage, interviewDate) {
  const order = ['Requested', 'Sourcing Profiles', 'Interview Scheduled', 'Selected', 'Offer Released', 'Joined'];
  const rank = order.indexOf(current);
  if (rank < 0) return null; // On Hold / Cancelled are manual
  let target = 'Sourcing Profiles';
  if (interviewDate || stage === 'Interview Scheduled' || stage === 'Interviewed') target = 'Interview Scheduled';
  if (stage === 'Selected') target = 'Selected';
  if (stage === 'Offer Released') target = 'Offer Released';
  if (stage === 'Joined') target = 'Joined';
  return order.indexOf(target) > rank ? target : null;
}

function deleteCandidate_(user, p) {
  requireRole_(user, ['Admin', 'HR']);
  const cand = readAll_('Candidates').find(function (c) { return c.ID === p.ID; });
  if (!cand) throw new Error('Candidate not found.');
  const req = readAll_('Requests').find(function (r) { return r.ID === cand.RequestID; }) || { ID: cand.RequestID, SerialNo: '' };
  deleteRows_('Candidates', [cand._row]);
  log_(req, user, 'Candidate removed', cand.Name);
  return true;
}

function getHistory_(user, p) {
  const req = readAll_('Requests').find(function (r) { return r.ID === p.ID; });
  if (!req || !canSee_(user, req)) throw new Error('Request not found.');
  return readAll_('History').filter(function (h) { return h.RequestID === p.ID; }).map(clean_).reverse();
}

function changePassword_(user, p) {
  if (hash_(p.current, user.Salt) !== user.PasswordHash) throw new Error('Current password is incorrect.');
  validatePassword_(p.next);
  user.Salt = Utilities.getUuid();
  user.PasswordHash = hash_(p.next, user.Salt);
  user.MustChange = 'FALSE';
  write_('Users', user._row, user);
  return true;
}

function listUsers_(user) {
  requireRole_(user, ['Admin']);
  return readAll_('Users').map(publicUser_);
}

function saveUser_(user, p) {
  requireRole_(user, ['Admin']);
  const email = String(p.Email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email.');
  if (ROLES.indexOf(p.Role) < 0) throw new Error('Invalid role.');
  if (!String(p.Name || '').trim()) throw new Error('Name is required.');
  const branch = String(p.Branch || '').toUpperCase().split(',').map(function (s) { return s.trim(); }).filter(String).join(',');
  if (p.Role === 'Head' && !branch) throw new Error('Assign at least one branch to a branch head.');

  const users = readAll_('Users');
  const existing = users.find(function (u) { return String(u.Email).toLowerCase() === email; });
  if (p.isNew) {
    if (existing) throw new Error('A user with this email already exists.');
    createUser_({ Email: email, Name: p.Name, Role: p.Role, Branch: branch, Password: p.Password });
    return true;
  }
  if (!existing) throw new Error('User not found.');
  const active = p.Active === undefined ? isTrue_(existing.Active) : isTrue_(p.Active);
  const admins = users.filter(function (u) { return u.Role === 'Admin' && isTrue_(u.Active); });
  if (existing.Role === 'Admin' && (p.Role !== 'Admin' || !active) && admins.length <= 1) {
    throw new Error('At least one active Admin is required.');
  }
  existing.Name = String(p.Name).trim();
  existing.Role = p.Role;
  existing.Branch = branch;
  existing.Active = active ? 'TRUE' : 'FALSE';
  if (p.Password) {
    validatePassword_(p.Password);
    existing.Salt = Utilities.getUuid();
    existing.PasswordHash = hash_(p.Password, existing.Salt);
    existing.MustChange = 'TRUE';
  }
  write_('Users', existing._row, existing);
  return true;
}

function saveBranch_(user, p) {
  requireRole_(user, ['Admin']);
  const code = String(p.Code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new Error('Branch code must be 2–8 letters/numbers (e.g. CHN).');
  if (!String(p.Name || '').trim()) throw new Error('Branch name is required.');
  const next = parseInt(p.NextSerial, 10);
  const branches = readAll_('Branches');
  const existing = branches.find(function (b) { return b.Code === code; });
  if (p.isNew) {
    if (existing) throw new Error('Branch code already exists.');
    write_('Branches', null, { Code: code, Name: String(p.Name).trim(), Location: String(p.Location || '').trim(),
      NextSerial: next > 0 ? next : 1, Active: 'TRUE', CreatedAt: now_() });
    return true;
  }
  if (!existing) throw new Error('Branch not found.');
  existing.Name = String(p.Name).trim();
  existing.Location = String(p.Location || '').trim();
  if (next > 0) existing.NextSerial = next;
  if (p.Active !== undefined) existing.Active = isTrue_(p.Active) ? 'TRUE' : 'FALSE';
  write_('Branches', existing._row, existing);
  return true;
}

/* ------------------------------------------------------------------ helpers */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setup() first.');
  return sh;
}

function readAll_(name) {
  const sh = sheet_(name);
  const headers = SCHEMA[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  const out = [];
  values.forEach(function (row, i) {
    if (row.join('') === '') return;
    const o = { _row: i + 2 };
    headers.forEach(function (h, j) { o[h] = cell_(row[j]); });
    out.push(o);
  });
  return out;
}

function write_(name, rowNum, obj) {
  const sh = sheet_(name);
  const headers = SCHEMA[name];
  const row = headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : String(obj[h]); });
  const r = rowNum || sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, headers.length).setNumberFormat('@').setValues([row]);
  obj._row = r;
  return r;
}

function deleteRows_(name, rows) {
  const sh = sheet_(name);
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}

function cell_(v) {
  if (v instanceof Date) {
    const tz = tz_();
    const hasTime = v.getHours() || v.getMinutes();
    return Utilities.formatDate(v, tz, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}

function clean_(o) {
  const c = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; });
  return c;
}

function log_(req, user, action, details) {
  write_('History', null, { At: now_(), RequestID: req.ID, SerialNo: req.SerialNo, User: user.Name + ' (' + user.Role + ')',
    Action: action, Details: details });
}

function session_(token) {
  if (!token) throw new Error('SESSION_EXPIRED');
  const cache = CacheService.getScriptCache();
  const email = cache.get('s_' + token);
  if (!email) throw new Error('SESSION_EXPIRED');
  const u = readAll_('Users').find(function (x) { return String(x.Email).toLowerCase() === email; });
  if (!u || !isTrue_(u.Active)) throw new Error('SESSION_EXPIRED');
  cache.put('s_' + token, email, SESSION_SECONDS); // sliding expiry
  return u;
}

function createUser_(p) {
  validatePassword_(p.Password);
  const salt = Utilities.getUuid();
  write_('Users', null, { Email: String(p.Email).toLowerCase(), Name: String(p.Name).trim(), Role: p.Role,
    Branch: p.Branch || '', PasswordHash: hash_(p.Password, salt), Salt: salt, Active: 'TRUE', MustChange: 'TRUE',
    CreatedAt: now_() });
}

function publicUser_(u) {
  return { Email: u.Email, Name: u.Name, Role: u.Role, Branch: u.Branch, Active: isTrue_(u.Active),
    MustChange: isTrue_(u.MustChange), CreatedAt: u.CreatedAt };
}

function hash_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + String(password || ''),
    Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function validatePassword_(pw) {
  if (!pw || String(pw).length < 6) throw new Error('Password must be at least 6 characters.');
}

function userBranches_(u) {
  return String(u.Branch || '').toUpperCase().split(',').map(function (s) { return s.trim(); }).filter(String);
}

function canSee_(user, req) {
  if (user.Role === 'Admin' || user.Role === 'HR') return true;
  return userBranches_(user).indexOf(String(req.Branch).toUpperCase()) >= 0;
}

function visibleRequests_(user) {
  return readAll_('Requests').filter(function (r) { return canSee_(user, r); });
}

function requireRole_(user, roles) {
  if (roles.indexOf(user.Role) < 0) throw new Error('You do not have permission for this action.');
}

function required_(p, keys) {
  keys.forEach(function (k) { if (!String(p[k] === undefined ? '' : p[k]).trim()) throw new Error(k + ' is required.'); });
}

function makeSerial_(code, n) {
  return code + '-' + ('000' + n).slice(-Math.max(3, String(n).length));
}

function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function now_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
