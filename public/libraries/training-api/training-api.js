/* public/libraries/training-api/training-api.js
 * Browser client for the Training domain under /v1/training.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };

  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.trainingApiBase) return clean(APP.trainingApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/training').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/training`;
    return `${location.origin}/v1/training`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = clean(options.baseUrl).replace(/\/+$/, '');
    if (object(options.headers)) state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function url(path = ''){
    const raw = clean(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${baseUrl()}/${raw.replace(/^\/+/, '')}`;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  function requestHeaders(options, body){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = {
      Accept:'application/json',
      ...state.defaultHeaders,
      ...(body != null && !(body instanceof FormData) ? { 'Content-Type':'application/json' } : {}),
      ...object(options.headers)
    };
    const csrf = csrfToken();
    if (csrf && !['GET','HEAD','OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const inputBody = options.body;
    const body = inputBody == null || inputBody instanceof FormData || typeof inputBody === 'string'
      ? inputBody
      : JSON.stringify(inputBody);
    const response = await fetch(url(path), {
      ...options,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:requestHeaders(options, inputBody)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Training API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  const me = {
    courses(orgId){ return request(orgPath(orgId, '/me/courses')); },
    course(orgId, courseId){ return request(orgPath(orgId, `/me/courses/${enc(courseId)}`)); },
    completeLesson(orgId, courseId, lessonId, input = {}){
      return request(orgPath(orgId, `/me/courses/${enc(courseId)}/lessons/${enc(lessonId)}/complete`), { method:'POST', body:input });
    },
    decks(orgId){ return request(orgPath(orgId, '/me/decks')); },
    deck(orgId, deckId){ return request(orgPath(orgId, `/me/decks/${enc(deckId)}`)); },
    quizzes(orgId){ return request(orgPath(orgId, '/me/quizzes')); },
    quiz(orgId, quizId){ return request(orgPath(orgId, `/me/quizzes/${enc(quizId)}`)); },
    recordAttempt(orgId, input = {}){ return request(orgPath(orgId, '/me/attempts'), { method:'POST', body:input }); }
  };

  const manage = {
    courses(orgId, options = {}){ return request(orgPath(orgId, `/manage/courses${queryString({ include_archived:options.includeArchived })}`)); },
    course(orgId, courseId){ return request(orgPath(orgId, `/manage/courses/${enc(courseId)}`)); },
    createCourse(orgId, input = {}){ return request(orgPath(orgId, '/manage/courses'), { method:'POST', body:input }); },
    saveCourse(orgId, courseId, input = {}){ return request(orgPath(orgId, `/manage/courses/${enc(courseId)}`), { method:'PUT', body:input }); },
    archiveCourse(orgId, courseId){ return request(orgPath(orgId, `/manage/courses/${enc(courseId)}`), { method:'DELETE' }); },

    decks(orgId, options = {}){ return request(orgPath(orgId, `/manage/decks${queryString({ include_archived:options.includeArchived, course_id:options.courseId })}`)); },
    deck(orgId, deckId){ return request(orgPath(orgId, `/manage/decks/${enc(deckId)}`)); },
    createDeck(orgId, input = {}){ return request(orgPath(orgId, '/manage/decks'), { method:'POST', body:input }); },
    saveDeck(orgId, deckId, input = {}){ return request(orgPath(orgId, `/manage/decks/${enc(deckId)}`), { method:'PUT', body:input }); },
    archiveDeck(orgId, deckId){ return request(orgPath(orgId, `/manage/decks/${enc(deckId)}`), { method:'DELETE' }); },

    quizzes(orgId, options = {}){ return request(orgPath(orgId, `/manage/quizzes${queryString({ include_archived:options.includeArchived, course_id:options.courseId })}`)); },
    quiz(orgId, quizId){ return request(orgPath(orgId, `/manage/quizzes/${enc(quizId)}`)); },
    createQuiz(orgId, input = {}){ return request(orgPath(orgId, '/manage/quizzes'), { method:'POST', body:input }); },
    saveQuiz(orgId, quizId, input = {}){ return request(orgPath(orgId, `/manage/quizzes/${enc(quizId)}`), { method:'PUT', body:input }); },
    archiveQuiz(orgId, quizId){ return request(orgPath(orgId, `/manage/quizzes/${enc(quizId)}`), { method:'DELETE' }); },

    assignments(orgId, options = {}){
      return request(orgPath(orgId, `/manage/assignments${queryString({ subject_kind:options.subjectKind, subject_id:options.subjectId })}`));
    },
    createAssignment(orgId, input = {}){ return request(orgPath(orgId, '/manage/assignments'), { method:'POST', body:input }); },
    updateAssignment(orgId, assignmentId, input = {}){ return request(orgPath(orgId, `/manage/assignments/${enc(assignmentId)}`), { method:'PATCH', body:input }); },
    deleteAssignment(orgId, assignmentId){ return request(orgPath(orgId, `/manage/assignments/${enc(assignmentId)}`), { method:'DELETE' }); },

    progress(orgId, courseId){ return request(orgPath(orgId, `/manage/courses/${enc(courseId)}/progress`)); },
    unlockLesson(orgId, courseId, lessonId, userId){
      return request(orgPath(orgId, `/manage/courses/${enc(courseId)}/lessons/${enc(lessonId)}/unlock`), { method:'POST', body:{ user_id:userId } });
    },
    relockLesson(orgId, courseId, lessonId, userId){
      return request(orgPath(orgId, `/manage/courses/${enc(courseId)}/lessons/${enc(lessonId)}/unlock/${enc(userId)}`), { method:'DELETE' });
    }
  };

  const api = { configure, baseUrl, url, request, me, manage };
  configure({ baseUrl:APP.trainingApiBase || '' });
  root.TrainingAPI = api;
})();
