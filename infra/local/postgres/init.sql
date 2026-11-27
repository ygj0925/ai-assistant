\set ON_ERROR_STOP on
\getenv assistant_password ASSISTANT_DB_PASSWORD
\getenv qa_password ASSISTANT_QA_DB_PASSWORD
\getenv assistant_database DB_NAME

CREATE ROLE assistant LOGIN PASSWORD :'assistant_password';
CREATE ROLE assistant_qa LOGIN PASSWORD :'qa_password';
CREATE DATABASE :"assistant_database" OWNER assistant;
REVOKE CONNECT ON DATABASE :"assistant_database" FROM PUBLIC;
