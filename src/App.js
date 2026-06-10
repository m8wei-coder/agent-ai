import React, { useState, useRef, useEffect } from "react";
import axios from "axios";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import { Layout, Typography, Alert } from "antd";

const DOMAIN = "http://localhost:5001";

const chatComponentStyle = {
  position: "fixed",
  bottom: "0",
  width: "80%",
  left: "10%", // this will center it because it leaves 10% space on each side
  marginBottom: "20px",
};

const pdfUploaderStyle = {
  margin: "auto",
  paddingTop: "80px",
};

const renderQAStyle = {
  height: "50%", // adjust the height as you see fit
  overflowY: "auto",
};

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [parseStatus, setParseStatus] = useState("idle");
  const pollRef = useRef(null);
  const { Header, Content } = Layout;
  const { Title } = Typography;

  const handleResp = (question, answer) => {
     setConversation((prev) => [...prev, { question, answer }]);
  };

  // 上传成功后开始轮询解析状态，直到 ready 或 error 才停止
  // （即使用户中途提问也继续轮询，让用户清楚看到何时解析完成）
  const startStatusPolling = () => {
    setParseStatus("parsing");
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await axios.get(`${DOMAIN}/status`);
        setParseStatus(data.status);
        if (data.status === "ready" || data.status === "error") {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (err) {
        console.error(`status poll error: ${err}`);
      }
    }, 1500);
  };

  // 组件卸载时清理定时器
  useEffect(() => () => clearInterval(pollRef.current), []);

  const statusBanner = {
    parsing: { type: "info", message: "Parsing document…" },
    ready: { type: "success", message: "Document ready — ask away!" },
    error: { type: "error", message: "Parsing failed. Please try uploading again." },
  }[parseStatus];

  return (
    <>
      <Layout style={{ height: "100vh", backgroundColor: "white" }}>
        <Header
          style={{
            display: "flex",
            alignItems: "center",
          }}
        >
          <Title style={{ color: "white " }}>Agent AI</Title>
        </Header>
        <Content style={{ width: "80%", margin: "auto" }}>
          <div style={pdfUploaderStyle}>
            <PdfUploader onParseStart={startStatusPolling} />
          </div>

          {statusBanner && (
            <Alert
              style={{ marginTop: "16px" }}
              type={statusBanner.type}
              message={statusBanner.message}
              showIcon
              banner
            />
          )}

          <br />
          <br />
          <div style={renderQAStyle}>
            <RenderQA conversation={conversation} isLoading={isLoading} />
          </div>

          <br />
          <br />
        </Content>
        <div style={chatComponentStyle}>
          <ChatComponent
            handleResp={handleResp}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
          />
        </div>
      </Layout>
    </>
  );
};

export default App;
