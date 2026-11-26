\set ON_ERROR_STOP on
\getenv assistant_password ASSISTANT_DB_PASSWORD
\getenv qa_password ASSISTANT_QA_DB_PASSWORD

CREATE ROLE assistant LOGIN PASSWORD :'assistant_password';
CREATE ROLE assistant_qa LOGIN PASSWORD :'qa_password';
CREATE DATABASE assistant OWNER assistant;
REVOKE CONNECT ON DATABASE assistant FROM PUBLIC;
