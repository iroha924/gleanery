-- 要件定義・設計書（requirements / design）の取り込み元を消す。子（文書の節・そのファイル・全文検索の索引）は
-- 外部キーの on delete cascade と、knowledge の削除の trigger が片付ける。0003 で種類を CHECK から外す。
delete from source_item where kind in ('requirements', 'design');
