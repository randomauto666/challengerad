/* Trage hier deine eigenen Supabase-Zugangsdaten ein (Supabase-Dashboard -> Project
   Settings -> API). Der "anon public key" ist bewusst öffentlich im Frontend-Code
   sichtbar – das ist normal und sicher, solange die Row-Level-Security-Regeln aus
   supabase-setup.sql aktiv sind. Er ersetzt KEIN Passwort, sondern identifiziert nur
   "das ist ein Aufruf von meiner Website". Ohne gültige Werte bleibt der komplette
   Community-Bereich (Login/Hinzufügen/Adminpanel) einfach ausgeblendet. */
const SUPABASE_CONFIG = {
    url: 'https://tlpithftbxbgpfrhuujz.supabase.co',
    anonKey: 'sb_publishable_pl6q7KzpjIyFZ4LFuslptg_fHhdT6-V',
};
