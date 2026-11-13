// ツボマップ3D：ログインと、ツボの共有データ（Firebase Authentication + Cloud Firestore）
//
// データの形
//   members/{メールアドレス}  { role: 'owner' | 'editor' | 'viewer', memo }   … 見られる人の名簿（管理者だけが書ける）
//   points/{id}               { name, note, p, n, region, created, updated }  … ツボ（名簿にいる人が読める。editor・owner が書ける）
// だれが読める・書けるかは、Firebase 側のルール（src/firestore.rules）で守る。この画面側の出し分けは見た目だけ。
export const SDK_VERSION = '12.15.0';
const BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;

export async function createBackend(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  auth.languageCode = 'ja';
  // 一度読んだツボは端末に残し、電波がなくても見られるようにする
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });

  let sessionCb = () => {}, unsubMember = null;
  const emit = s => sessionCb(s);
  function watch(user) {
    if (unsubMember) { unsubMember(); unsubMember = null; }
    if (!user) return emit({ state: 'out' });
    const email = user.email || '';
    if (!user.emailVerified) return emit({ state: 'unverified', email });
    // 名簿の自分の行を見張る：許可・取り消し・役割の変更が、開いたままの画面にも届く
    unsubMember = F.onSnapshot(F.doc(db, 'members', email), snap => {
      const role = snap.exists() ? snap.data().role : null;
      emit(['owner', 'editor', 'viewer'].includes(role) ? { state: 'in', email, role } : { state: 'denied', email });
    }, () => emit({ state: 'denied', email }));
  }
  A.onAuthStateChanged(auth, watch);

  const pointDoc = id => F.doc(db, 'points', id);
  const memberDoc = email => F.doc(db, 'members', email.trim().toLowerCase());
  return {
    onSession(cb) { sessionCb = cb; },
    signIn: (email, pw) => A.signInWithEmailAndPassword(auth, email.trim(), pw),
    async signUp(email, pw) {
      const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), pw);
      await A.sendEmailVerification(cred.user);
    },
    resend: () => A.sendEmailVerification(auth.currentUser),
    reset: email => A.sendPasswordResetEmail(auth, email.trim()),
    signOut: () => A.signOut(auth),
    async recheck() {       // メールの確認が済んだか・許可が出たかを、サーバーに確かめ直す
      const u = auth.currentUser; if (!u) return;
      await u.reload();
      await u.getIdToken(true);
      watch(auth.currentUser);
    },
    onPoints(cb, onErr) {
      return F.onSnapshot(F.collection(db, 'points'), snap => cb(snap.docs.map(d => ({ ...d.data(), id: d.id }))), e => { cb([]); if (onErr) onErr(e); });
    },
    savePoint: pt => F.setDoc(pointDoc(pt.id), { name: pt.name, note: pt.note, p: pt.p, n: pt.n, region: pt.region, created: pt.created, updated: F.serverTimestamp() }),
    deletePoint: id => F.deleteDoc(pointDoc(id)),
    onMembers(cb, onErr) {
      return F.onSnapshot(F.collection(db, 'members'), snap => cb(snap.docs.map(d => ({ email: d.id, role: d.data().role, memo: d.data().memo || '' }))), e => { cb([]); if (onErr) onErr(e); });
    },
    setMember: (email, role, memo) => F.setDoc(memberDoc(email), { role, memo: memo || '' }),
    removeMember: email => F.deleteDoc(memberDoc(email)),
  };
}

// エラーを、画面に出す言葉に直す
export function explain(e) {
  const code = e && e.code || '';
  const t = {
    'auth/invalid-credential': 'メールアドレスかパスワードが違います。',
    'auth/wrong-password': 'メールアドレスかパスワードが違います。',
    'auth/user-not-found': 'メールアドレスかパスワードが違います。',
    'auth/invalid-email': 'メールアドレスの形が正しくありません。',
    'auth/missing-password': 'パスワードを入れてください。',
    'auth/weak-password': 'パスワードが短すぎます。8文字以上にしてください。',
    'auth/email-already-in-use': 'このメールアドレスは登録済みです。「ログインに戻る」からログインしてください。',
    'auth/too-many-requests': '試した回数が多すぎます。しばらく待ってから、もう一度お試しください。',
    'auth/network-request-failed': '通信できませんでした。電波の状態を確かめてください。',
    'auth/user-disabled': 'このアカウントは止められています。',
    'permission-denied': 'この操作は許可されていません。',
    'unavailable': '通信できませんでした。電波の状態を確かめてください。',
  }[code];
  return t || ('うまくいきませんでした（' + (code || (e && e.message) || e) + '）');
}
