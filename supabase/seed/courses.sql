-- Course catalogue: Teknik Komputer UI, mandatory courses, semesters 1-4.
--
-- ⚠ VERIFY BEFORE SUBMISSION: names/semesters were drafted from general
-- knowledge of the programme and must be checked against the official
-- curriculum (SIAK-NG / curriculum handbook). Course CODES are Lerne-internal
-- placeholders (TKx-yy), NOT official UI course codes.
-- University-wide general courses (MPKT, Agama, etc.) are intentionally excluded.

insert into public.courses (code, name, semester) values
  ('TK1-01', 'Kalkulus 1', 1),
  ('TK1-02', 'Fisika Dasar 1', 1),
  ('TK1-03', 'Dasar-Dasar Pemrograman', 1),
  ('TK1-04', 'Pengantar Teknik Komputer', 1),
  ('TK1-05', 'Aljabar Linear', 1),
  ('TK2-01', 'Kalkulus 2', 2),
  ('TK2-02', 'Fisika Dasar 2', 2),
  ('TK2-03', 'Matematika Diskrit', 2),
  ('TK2-04', 'Rangkaian Listrik', 2),
  ('TK2-05', 'Sistem Digital', 2),
  ('TK2-06', 'Pemrograman Berorientasi Objek', 2),
  ('TK3-01', 'Struktur Data dan Algoritma', 3),
  ('TK3-02', 'Probabilitas dan Statistika', 3),
  ('TK3-03', 'Elektronika', 3),
  ('TK3-04', 'Organisasi dan Arsitektur Komputer', 3),
  ('TK3-05', 'Sinyal dan Sistem', 3),
  ('TK4-01', 'Sistem Operasi', 4),
  ('TK4-02', 'Jaringan Komputer', 4),
  ('TK4-03', 'Basis Data', 4),
  ('TK4-04', 'Sistem Embedded', 4),
  ('TK4-05', 'Metode Numerik', 4),
  ('TK4-06', 'Rekayasa Perangkat Lunak', 4)
on conflict (code) do update set name = excluded.name, semester = excluded.semester;
