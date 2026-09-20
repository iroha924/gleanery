-- session の題。null なら harvest が生成して埋める（生成できるまでは最初の発言の冒頭で代用する）。
alter table gleanery.conversation add column if not exists title text;
