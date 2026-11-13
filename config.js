// ログインと、ツボの保存先（Firebase）の設定。
// Firebase の管理画面の「プロジェクトの設定 → マイアプリ → SDK の設定と構成」に出る内容を、そのまま入れる。
// ここに入れる値は、アプリが Firebase に接続するための宛先で、秘密の鍵ではない（公開してよい）。
// だれが見られるか・書けるかは、Firebase 側のルール（src/firestore.rules）で守る。
export const firebaseConfig = {
  apiKey: "AIzaSyBoUlhVMHaTd_wiT4HgKkMsfX1nxkND9qo",
  authDomain: "tsubomap3d.firebaseapp.com",
  projectId: "tsubomap3d",
  storageBucket: "tsubomap3d.firebasestorage.app",
  messagingSenderId: "572295695010",
  appId: "1:572295695010:web:2d77877c1c9c8a708be5fb",
};
