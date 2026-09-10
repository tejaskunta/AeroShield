# AeroShield

AeroShield is a mission-focused drone safety and detection console for AI-assisted landmine monitoring and route planning. The project combines a simulated mission dashboard, a FastAPI backend, and a frontend workflow for reviewing detections, risk patterns, telemetry, and safe corridors in a single operator view.

This repository is currently structured as a simulator-first prototype: the frontend models mission traffic and detection activity in-browser, while the backend exposes a lightweight API foundation for future YOLO or sensor integration.

---

## Project goal

AeroShield is designed to give an operator a clear understanding of:

- current drone telemetry and mission state
- hazard and caution detections across a mapped area
- risk concentration and coverage movement
- safe route planning around uncertain or flagged cells
- mission reporting and operator review workflows

The system is intentionally built around an operator interface rather than a raw model pipeline alone. The UX is tuned for rapid decision-making in a monitoring environment.

---

## Current implementation status

### Frontend

- React + TypeScript + Vite app
- Mission control dashboard with live map and drone telemetry
- Detection center and review workflow
- Analytics and safety copilots screens
- Mission reports and status summaries
- Simulated mission stream with detections and path planning

### Backend

- FastAPI service with health and root endpoints
- detection API for uploaded image handling
- mock detection service ready to be replaced by real model inference

### Current model reality

- The app uses client-side simulation data in the frontend
- The backend currently returns mock detection results instead of live YOLO predictions
- The repo is best understood as a foundation for a real AI mission platform rather than a final production deployment

---

## Repository structure

```text
AeroShield Project/
├── README.md
├── README_BACKEND_GUIDE.md
├── requirements.txt
├── week3_train_yolov8.py
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── api/
│       │   └── detection.py
│       ├── schemas/
│       │   └── detection.py
│       └── services/
│           └── detection_service.py
├── configs/
│   └── data.yaml.example
├── docs/
│   └── TRAINING_NOTES.md
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── screens/
│       └── types/
├── jetson/
│   ├── README.md
│   ├── build_engine.sh
│   └── infer_trt.py
├── scripts/
│   ├── check_env.py
│   ├── export_onnx.py
│   ├── predict.py
│   └── verify_dataset.py
├── weights/
│   └── README.txt
└── .gitignore
```

---

## Tech stack

### Frontend

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Leaflet + React Leaflet
- Recharts
- React Router

### Backend

- Python
- FastAPI
- Uvicorn
- Python multipart upload support

### AI / inference work

- YOLOv8-related scripts and training assets are present in the project root and under the `scripts/` and `jetson/` directories
- Model integration is in progress and not yet fully connected to the live backend API

---

## Quick start

### 1. Clone and install backend dependencies

```bash
cd "AeroShield Project"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r .\backend\requirements.txt
```

### 2. Run the backend

```bash
cd "AeroShield Project"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir .\backend
```

The backend will be available at:

- http://127.0.0.1:8000/
- Swagger docs: http://127.0.0.1:8000/docs

### 3. Install and run the frontend

```bash
cd "AeroShield Project\frontend"
npm install
npm run dev -- --host 0.0.0.0
```

Open:

- http://localhost:5173/

---

## Frontend app overview

At the main mission dashboard, the app presents:

- a mission map with detection overlays
- a status rail with telemetry and detection counts
- a drone summary with battery, link, GPS, altitude, and speed
- a safe path planner with start/end selection and route plotting
- a detections ticker for operator review

Key screens are mounted via the router in [frontend/src/App.tsx](frontend/src/App.tsx):

- Mission Control
- Detection Center
- Analytics
- Safety Copilot
- Mission Reports

---

## Backend API

The current FastAPI implementation exposes:

```http
GET /
GET /health
POST /api/detect
```

Example behavior:

- `/` returns a simple service-running message
- `/health` returns a health status payload
- `/api/detect` accepts an uploaded image and returns a mock detection response

The mock detection service is defined in [backend/app/services/detection_service.py](backend/app/services/detection_service.py) and is intended to be replaced later with real detection logic.

---

## Development notes

### Frontend verification

The current frontend was validated by running:

```bash
cd "AeroShield Project\frontend"
npm run build
```

This completed successfully, confirming the app compiles cleanly in its current state.

### Current design assumption

The current project is simulation-led and operator-first. That means the interface and workflow are already shaped around real mission operations even though the underlying detection pipeline is not fully or continuously connected to a live model yet.

---

## Documentation

Additional documentation in the repo:

- [README_BACKEND_GUIDE.md](README_BACKEND_GUIDE.md) — backend-focused setup and API notes
- [docs/TRAINING_NOTES.md](docs/TRAINING_NOTES.md) — training and dataset notes for the model-oriented part of the project
- [jetson/README.md](jetson/README.md) — Jetson-side deployment notes

---

## Roadmap direction

The likely next evolution of this project is:

1. connect the backend to a real model inference path
2. replace mock detection payloads with YOLO or TensorRT outputs
3. wire live mission telemetry into the frontend
4. tighten the analytics, risk scoring, and operator review workflows
5. support deployment to field-ready drone mission tooling

---

## License

This repository does not currently declare a project license in the root package metadata. Review your team or institutional requirements before distributing the project externally.

---

## Contribution

Use the repository as a working prototype for a drone safety and detection platform. Contributions should keep the operator workflow practical and the model/inference integration clearly separated from the UI logic.

## Repo layout

```
AeroShield/
├── backend/                   ← FastAPI backend (detection API, future agents)
├── frontend/                  ← React dashboard (to be developed)
├── jetson/                    ← Jetson Nano deployment (TensorRT)
├── ml/                        ← YOLOv8 training pipeline
├── scripts/
│   ├── check_env.py            run this first
│   ├── verify_dataset.py       run this before every training run
│   ├── export_onnx.py          standalone re-export
│   └── predict.py              visual sanity check
├── week3_train_yolov8.py       ← main training deliverable: train → val → export
├── configs/data.yaml.example
├── docs/TRAINING_NOTES.md      ← what to record for the report
├── docker-compose.yml          ← (to be developed) service orchestration
└── README.md
```

---

## Stack (per PRD §7)

| Component | Tool |
|---|---|
| Detection model | YOLOv8s (Ultralytics), TensorRT-exported |
| Training | PyTorch + CUDA 12.4, RTX 4070 8 GB |
| Deployment | Jetson Nano P3450, JetPack 4.6, TensorRT 8.2, FP16 |
| Explainability | Grad-CAM (Week 5 — needs `best.pt`, not the engine) |

**Keep `best.pt`.** Grad-CAM (PRD §5.1, the highest-ROI feature) runs against
the PyTorch checkpoint, not the TensorRT engine. The `.pt` file is not disposable
once you have the `.onnx`.

## Dataset licensing

Public datasets (Roboflow Universe etc.) are typically CC BY 4.0 — you must
attribute them in the final report and repo (PRD §10). Record every source in
[docs/TRAINING_NOTES.md](docs/TRAINING_NOTES.md) as you go; reconstructing it in
week 12 is miserable.

======================================================================
SE LAB INTERNAL – MASTER CHECKLIST
BASIC → ADVANCED | MAVEN + GIT/GITHUB + DOCKER + DOCKER HUB
======================================================================

PURPOSE
-------
Use this file as a PRACTICAL CHECKLIST, not just a command dump.

Golden flow:

GITHUB → CLONE → MAVEN/POM → BUILD JAR/WAR → DOCKERFILE
       → DOCKER IMAGE → RUN CONTAINER → TEST
       → DOCKER HUB PUSH/PULL → GITHUB PUSH

MOST IMPORTANT DISTINCTION
---------------------------
GitHub   = source-code repository
Docker Hub = Docker image repository

JAR     = usually Java runs it directly
WAR     = traditional WAR is deployed by Tomcat

======================================================================
PART A – BEFORE STARTING: ENVIRONMENT CHECK
======================================================================

1. Check Git:
git --version

2. Check Java:
java -version

3. Check Java compiler:
javac -version

4. Check Maven and WHICH JAVA MAVEN IS USING:
mvn -version

IMPORTANT:
Do NOT assume java -version and mvn -version use the same JDK.
For a Java 17 project, Maven should also show Java 17.

5. Check Docker:
docker --version

6. Check Docker engine/containers:
docker ps

If Docker commands fail, make sure Docker Desktop is running.

======================================================================
PART B – GITHUB: CLONE AN EXISTING PROJECT
======================================================================

Go to the folder where you want the project:
cd ~/Desktop/githubmavn

Clone:
git clone <GITHUB_URL>

Example:
git clone https://github.com/deepthisagar7/library-management.git

Enter project:
cd library-management

Check:
git status

ECLIPSE IMPORT FLOW (FROM LAB INSTRUCTIONS)
--------------------------------------------
File → Import → Git → Projects from Git (with smart import)
→ Clone URI → Next → enter URL → choose branch/location → Finish.

IMPORTANT:
Do not run git clone INSIDE an already-cloned project.

If you want another fresh project:
cd ..
git clone <NEW_URL>

======================================================================
PART C – POM.XML: WHAT TO CHECK FIRST
======================================================================

When a POM is given with errors, check in this order:

1. XML syntax
2. groupId
3. artifactId
4. version
5. packaging (jar or war)
6. Java version/compiler settings
7. dependencies
8. build/plugins
9. finalName if exact output filename is required
10. Main-Class if an executable JAR must run with java -jar

BASIC XML SYNTAX
----------------
Opening tag:
<tag>

Closing tag:
</tag>

Correct:
<version>1.0-SNAPSHOT</version>

WRONG:
<version>1.0-SNAPSHOT<version>

Attributes belong inside opening tag:
<project xmlns="..." xmlns:xsi="...">

NOT:
<project><xmlns="...">

Correct project opening:
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         https://maven.apache.org/xsd/maven-4.0.0.xsd">

======================================================================
PART D – MAVEN: JAR PROJECT
======================================================================

Exam-style Java 17 + JAR core:

<groupId>com.library</groupId>
<artifactId>library-management</artifactId>
<version>1.0-SNAPSHOT</version>

<packaging>jar</packaging>

<properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
</properties>

If the exact filename must be:
target/library-management.jar

add:
<build>
    <finalName>library-management</finalName>
</build>

WHY FINALNAME?
--------------
Without finalName, Maven normally includes artifactId + version:
library-management-1.0-SNAPSHOT.jar

With:
<finalName>library-management</finalName>

output becomes:
library-management.jar

FINALNAME changes the OUTPUT FILENAME.
It does NOT choose which Java class runs.

======================================================================
PART E – EXECUTABLE JAR: MAIN-CLASS MANIFEST
======================================================================

ERROR:
no main manifest attribute, in app.jar

MEANING:
The JAR exists, but its manifest does not specify which class contains
the main() method for "java -jar".

FIRST FIND:
public static void main(String[] args)

Example:
package com.library;

public class LibraryManagement {
    public static void main(String[] args) {
        ...
    }
}

Fully qualified class name:
com.library.LibraryManagement

ADD TO POM (INSIDE <build>):
----------------------------------------------------------------------
<build>
    <finalName>library-management</finalName>

    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-jar-plugin</artifactId>
            <version>3.4.2</version>
            <configuration>
                <archive>
                    <manifest>
                        <mainClass>com.library.LibraryManagement</mainClass>
                    </manifest>
                </archive>
            </configuration>
        </plugin>
    </plugins>
</build>
----------------------------------------------------------------------

Then rebuild:
mvn clean package

Test the JAR BEFORE Docker:
java -jar target/library-management.jar

EXPECTED:
The program's output appears.

KEY DISTINCTION:
finalName  → JAR filename
mainClass  → class run by java -jar

NOTE:
For a normal WAR deployed by Tomcat, this Main-Class setup is NOT
what makes the WAR run. Tomcat deploys the WAR.

======================================================================
PART F – MAVEN BUILD + TROUBLESHOOTING
======================================================================

Build:
mvn clean package

Why clean?
Removes previous build output.

Why package?
Compiles/tests/packages according to the POM, producing JAR/WAR.

Check target:
dir target
OR
ls target

If JAR is missing:
1. Check BUILD SUCCESS.
2. Check packaging in POM.
3. Check target/ contents.
4. Check finalName if exact filename was expected.
5. Check Maven errors.

IMPORTANT MAVEN LIFECYCLE PHASES
--------------------------------
clean   → remove previous build output
compile → compile main source
test    → run tests
package → create JAR/WAR
install → install artifact into local Maven repository (.m2)

PACKAGE generates the JAR/WAR.

======================================================================
PART G – JAVA 17 ERROR: EXACT EXAM DEBUGGING
======================================================================

Question type:
After changing project to Java 17, "mvn clean package" gives
unsupported source/target/release version.

STEP 1:
java -version

STEP 2:
javac -version

STEP 3:
mvn -version

COMPARE:
POM says 17
but Maven says Java 8
→ mismatch.

FIX:
Make sure JDK 17 is installed.
Make Maven/system JAVA_HOME/PATH point to JDK 17.
Restart terminal/IDE if necessary.

VERIFY AGAIN:
java -version
mvn -version

THEN:
mvn clean package

IMPORTANT:
mvn -version is the command proving which Java Maven is using.

======================================================================
PART H – JAR EXECUTION DEBUGGING
======================================================================

After Maven:
java -jar target/library-management.jar

If it works:
Continue to Docker.

If "no main manifest attribute":
→ configure maven-jar-plugin Main-Class
→ mvn clean package
→ test java -jar again

If "Unable to access jarfile":
→ check exact target filename
→ run dir target / ls target
→ fix Docker COPY or java command filename

If Java source/target error:
→ java -version
→ javac -version
→ mvn -version
→ fix JDK/Maven Java mismatch
→ rebuild

======================================================================
PART I – WAR PROJECT: MAVEN SIDE
======================================================================

For a traditional WAR project:
<packaging>war</packaging>

Build:
mvn clean package

Check:
dir target
OR
ls target

Expected:
target/<something>.war

Servlet API:
Do NOT automatically add it just because the project is a WAR.
Check the actual project/POM/source requirements.

For Tomcat 9 traditional servlet applications:
javax.servlet.* is the older namespace commonly associated with
Tomcat 9-era applications.
Do not blindly switch to jakarta.servlet.* without checking the project.

======================================================================
PART J – DOCKERFILE: JAR
======================================================================

For exam-style executable JAR + Java 17:

FROM eclipse-temurin:17-jdk

COPY target/library-management.jar app.jar

EXPOSE 8080

CMD ["java", "-jar", "app.jar"]

MEANING:
FROM   → base image with Java 17
COPY   → copy JAR into image
EXPOSE → documents container port 8080
CMD    → execute JAR

IMPORTANT:
EXPOSE DOES NOT PUBLISH A PORT TO YOUR COMPUTER.

Port publishing happens with docker run -p.

======================================================================
PART K – DOCKERFILE: WAR + TOMCAT
======================================================================

College lab pattern:

FROM tomcat:9.0

COPY target/*.war /usr/local/tomcat/webapps/ROOT.war

EXPOSE 8080

CMD ["catalina.sh", "run"]

MEANING:
FROM tomcat:9.0
→ Tomcat base image.

COPY target/*.war /usr/local/tomcat/webapps/ROOT.war
→ put WAR into Tomcat's webapps directory.
→ ROOT.war makes it the root web application (/).

EXPOSE 8080
→ documents Tomcat's container port.
→ does NOT change Tomcat's internal listening port.

CMD ["catalina.sh", "run"]
→ starts Tomcat in the foreground.

MEMORY:
JAR → Java / java -jar
WAR → Tomcat / catalina.sh run

======================================================================
PART L – DOCKER BUILD
======================================================================

FIRST CHECK:
You are in the directory containing:
Dockerfile
pom.xml
target/

Example:
cd C:\Users\LENOVO\Desktop\githubmavn\library-management

Check:
dir
dir target

BUILD:
docker build -t librarydemo:latest .

IMPORTANT:
The final "." is REQUIRED.
It means the current directory is the build context.

COMMON ERROR:
docker build -t librarydemo:latest
→ docker says buildx build requires 1 argument.

FIX:
docker build -t librarydemo:latest .

If COPY says:
target/...jar: not found

CHECK:
dir target
ls target

Then make Dockerfile COPY EXACTLY match the generated file.

Also check .dockerignore.
If it contains:
target/
Docker may not receive the target directory in the build context.

======================================================================
PART M – DOCKER IMAGE CHECK
======================================================================

List images:
docker image ls

Alternative:
docker images

Expected example:
librarydemo    latest

Image = packaged template used to create containers.

======================================================================
PART N – DOCKER RUN
======================================================================

GENERAL:
docker run -d -p HOST_PORT:CONTAINER_PORT --name CONTAINER_NAME IMAGE:TAG

JAR exam style (host 8080 if available):
docker run -d -p 8080:8080 --name library-container library-management:latest

YOUR PC IF JENKINS USES HOST 8080:
docker run -d -p 8083:8080 --name library-container librarydemo:latest

WAR/TOMCAT:
docker run -d -p 8083:8080 --name library-war-container library-war:latest

MEANING:
-d → detached/background
-p HOST:CONTAINER → port mapping
--name → container name
IMAGE:TAG → image to run

IMPORTANT:
-p 8083:8080 means:
Your PC port 8083 → container port 8080

It does NOT mean:
container Tomcat now listens on 8083.

======================================================================
PART O – DOCKER PORT CONFUSION / CONFLICTS
======================================================================

ERROR:
port is already allocated / only one usage of each socket address...

MEANING:
The HOST PORT is already used by another program/container.

CHECK:
docker ps

Also Windows:
netstat -ano | findstr :8083

If Jenkins occupies 8080:
Use a different HOST port, e.g.
-p 8083:8080

For Tomcat:
container port is normally 8080.

DO NOT confuse:
EXPOSE 8083
with
-p 8083:8080

The first is documentation.
The second actually maps host to container.

======================================================================
PART P – DOCKER CONTAINER CHECKS
======================================================================

Only RUNNING containers:
docker ps

ALL containers, including stopped:
docker ps -a

Why did it stop?
docker logs <container-name>

Detailed configuration:
docker inspect <container-name>

If the container disappears from docker ps:
Run:
docker ps -a

A container may have started and immediately exited.

For a console Java app:
java -jar app.jar
prints output and exits.
That is NORMAL.

Therefore:
docker ps       → may not show it
docker ps -a    → shows it as Exited
docker logs NAME → shows printed output

======================================================================
PART Q – DOCKER STOP / START / REMOVE
======================================================================

Stop:
docker stop library-container

Start an existing stopped container:
docker start library-container

Remove stopped container:
docker rm library-container

Force remove:
docker rm -f library-container

If name is already in use:
docker ps -a
docker rm <old-container>
OR choose another name.

IMPORTANT:
A stopped container still reserves its name.

======================================================================
PART R – DOCKER LOGS / DEBUGGING
======================================================================

Check output:
docker logs library-container

Follow logs:
docker logs -f library-container

If application crashes:
Read the logs BEFORE changing random Docker commands.

Examples:

"no main manifest attribute"
→ JAR manifest/Main-Class issue.

"Unable to access jarfile ..."
→ wrong filename/copy path.

"port already in use"
→ port conflict.

"connection refused"
→ container/application/port issue.

404 Not Found
→ server responded, but URL/route/application path may be wrong.

======================================================================
PART S – ENTER A RUNNING CONTAINER
======================================================================

Shell:
docker exec -it <container-name> /bin/sh

If bash exists:
docker exec -it <container-name> bash

Interactive Ubuntu example:
docker run -it ubuntu bash

Lab also covers:
docker run -it <container-id/name> bash

Use this to inspect files/processes inside a container.

======================================================================
PART T – 404 VS CONNECTION PROBLEM
======================================================================

CONNECTION REFUSED:
Likely container/server/port not reachable.

404 NOT FOUND:
Something responded, but requested resource/path was not found.

For 404 troubleshooting:
1. Check docker ps
2. Check docker logs <container>
3. Verify application actually started
4. Verify correct URL/context path
5. Verify application is listening on expected internal port
6. Enter container if needed:
   docker exec -it <container> /bin/sh

======================================================================
PART U – DOCKER HUB
======================================================================

Docker Hub stores DOCKER IMAGES.

Step 1 – Login:
docker login

If prompted, authenticate with Docker Hub credentials/token.

Step 2 – See local image:
docker image ls

Step 3 – Tag:
docker tag LOCAL_IMAGE YOUR_USERNAME/REPOSITORY:latest

Example:
docker tag librarydemo:latest YOUR_USERNAME/librarydemo:latest

Step 4 – Push:
docker push YOUR_USERNAME/librarydemo:latest

IMPORTANT DOCKER HUB FORMAT:
<dockerhub-username>/<repository-name>:<tag>

Lab example pattern:
kumbhambhargavi/lmsimage:latest

GENERAL:
docker tag image:tag username/repository:tag
docker push username/repository:tag

======================================================================
PART V – DOCKER HUB PULL
======================================================================

Pull:
docker pull YOUR_USERNAME/librarydemo:latest

Check:
docker image ls

Run:
docker run -d -p 8083:8080 --name library-container \
YOUR_USERNAME/librarydemo:latest

This proves:
Docker Hub → local image → container.

======================================================================
PART W – DOCKER HUB FULL FLOW
======================================================================

LOCAL:
docker build -t librarydemo:latest .

LOGIN:
docker login

TAG:
docker tag librarydemo:latest YOUR_USERNAME/librarydemo:latest

PUSH:
docker push YOUR_USERNAME/librarydemo:latest

LATER:
docker pull YOUR_USERNAME/librarydemo:latest

RUN:
docker run -d -p 8083:8080 --name library-container \
YOUR_USERNAME/librarydemo:latest

MEMORY:
build → tag → push
pull → run

======================================================================
PART X – GITHUB: PUSH LOCAL PROJECT
======================================================================

If repository is not initialized:
git init

Check:
git status

Add:
git add .

Commit:
git commit -m "Initial commit"

Branch:
git branch -M main

Connect:
git remote add origin https://github.com/YOUR_USERNAME/library-management.git

Check:
git remote -v

Push:
git push -u origin main

IMPORTANT:
This pushes SOURCE CODE to GitHub.

Docker Hub PUSH pushes IMAGE to Docker Hub.

======================================================================
PART Y – GITHUB REMOTE PROBLEMS
======================================================================

See remote:
git remote -v

Add:
git remote add origin <URL>

Change URL:
git remote set-url origin <NEW_URL>

Remove:
git remote remove origin

Rename:
git remote rename origin upstream

Detailed:
git remote show origin

If trying to push to someone else's repository:
You may get access denied.

Use your own GitHub repository URL and:
git remote set-url origin https://github.com/YOUR_USERNAME/REPOSITORY.git

Then:
git push -u origin main

If lab computer stores old GitHub credentials, remove/correct the
stored credentials before retrying authentication.

======================================================================
PART Z – GITHUB BRANCHING / MERGING
======================================================================

List local branches:
git branch

List local + remote:
git branch -a

List remote:
git branch -r

Create branch:
git branch feature/book-management

Create + switch:
git checkout -b feature/book-management

Modern:
git switch -c feature/book-management

Switch:
git checkout main
or
git switch main

Delete merged branch:
git branch -d feature/book-management

Force delete unmerged:
git branch -D feature/experiment

Check merged:
git branch --merged

Delete multiple local merged branches:
git branch -d feature-a feature-b feature-c

Merge:
git checkout main
git merge feature/book-management

======================================================================
PART AA – MERGE CONFLICT
======================================================================

Scenario:
You merge and Git reports a conflict.

STEP 1:
git status

STEP 2:
Open conflicted file.

Look for:
<<<<<<<
=======
>>>>>>>

STEP 3:
Manually keep the correct code and REMOVE conflict markers.

STEP 4:
Stage:
git add <resolved-file>

STEP 5:
Complete merge:
git commit

STEP 6:
Push:
git push

The lab instructions explicitly use this conflict-resolution process.

======================================================================
PART AB – UNDO / RESTORE / STAGING
======================================================================

Discard local unstaged changes to one file:
git restore filename

Remove from staging but KEEP the changes:
git restore --staged filename

Remove everything from staging:
git restore --staged .

Older equivalent:
git reset filename

WARNING:
Do NOT use git reset --hard casually.
It can discard local changes.

Already committed but NOT pushed – correct message:
git commit --amend -m "Corrected commit message"

Already committed and pushed – safer undo:
git revert <commit-id>
git push

View history:
git log
git log --oneline

View differences not staged:
git diff

Show a commit:
git show <commit>

======================================================================
PART AC – GIT STASH
======================================================================

Save uncommitted changes:
git stash

Switch branch:
git switch main

Return:
git switch feature/login

Bring changes back:
git stash apply

Use when you need to temporarily put work aside.

======================================================================
PART AD – REMOTE UPDATE COMMANDS
======================================================================

Fetch remote changes without merging:
git fetch origin

Fetch specific branch:
git fetch origin feature-branch

Pull remote changes and merge:
git pull origin main

Set upstream on first push:
git push --set-upstream origin feature-branch

Rebase local branch onto remote:
git fetch origin
git rebase origin/main

Prune deleted remote branch references:
git remote prune origin

======================================================================
PART AE – RECOVER DELETED BRANCH
======================================================================

Find old references:
git reflog

Recreate branch:
git checkout -b feature-ui <commit_hash>

======================================================================
PART AF – .GITIGNORE
======================================================================

Create:
touch .gitignore

Typical Maven:
target/

IDE files:
.classpath
.project
.settings/

Logs:
*.log

Temporary:
*.bak
temp/

IMPORTANT:
.gitignore prevents matching UNTRACKED files from being added.

If a file is ALREADY TRACKED, adding it to .gitignore does not
automatically untrack it.

To stop tracking while keeping the file locally:
git rm --cached <file>

Then commit:
git add .gitignore
git commit -m "Update gitignore"
git push

======================================================================
PART AG – API KEY / SENSITIVE FILE
======================================================================

If a secret file has been committed, simply adding it to .gitignore
does NOT remove it from history.

Lab material includes history-removal methods.

Basic historical command shown in lab:
git filter-branch --force --index-filter \
"git rm --cached --ignore-unmatch secrets.txt" \
--prune-empty --tag-name-filter cat -- --all

WARNING:
This rewrites history. For a real shared repository, use an
appropriate modern history-rewrite procedure and coordinate with
the team.

Also ROTATE/REVOKE the exposed key.

======================================================================
PART AH – USEFUL GIT INVESTIGATION COMMANDS
======================================================================

Who changed a line:
git blame script.py

Readable history:
git log --oneline

Difference:
git diff

Commit details:
git show <commit>

Remote details:
git remote show origin

======================================================================
PART AI – COMMON FAILURE POINTS THAT BREAK THE FLOW
======================================================================

1. Docker build missing "."
FIX:
docker build -t image:latest .

2. Wrong COPY filename/path
FIX:
dir target
ls target
Make COPY match exact generated file.

3. target/ missing
FIX:
mvn clean package

4. target/ excluded by .dockerignore
FIX:
inspect .dockerignore.

5. Java version mismatch
FIX:
java -version
mvn -version
Make Maven use JDK 17.

6. "no main manifest attribute"
FIX:
configure maven-jar-plugin Main-Class
mvn clean package
test java -jar

7. Container name already exists
FIX:
docker ps -a
docker rm <name>
or choose another name.

8. Port already in use
FIX:
check who uses host port.
Use another host port:
-p 8083:8080

9. Container missing from docker ps
FIX:
docker ps -a
docker logs <name>

10. Container exits immediately
For a console Java program, this may be NORMAL:
program prints output → exits → container exits.

11. 404
FIX:
check URL/context path, application startup, logs, internal port.

12. Docker daemon unavailable
FIX:
Start Docker Desktop.

13. Git remote wrong
FIX:
git remote -v
git remote set-url origin <correct URL>

14. Git push rejected / authentication problem
FIX:
Check correct GitHub account/credentials and repository access.
Then retry.

15. Git merge conflict
FIX:
git status
edit file
remove <<<<<<< ======= >>>>>>>
git add <file>
git commit
git push

======================================================================
PART AJ – EXACT SET-3 PART III ANSWERS
======================================================================

3.a Dockerfile for JAR:
----------------------------------------------------------------------
FROM eclipse-temurin:17-jdk

COPY target/library-management.jar app.jar

EXPOSE 8080

CMD ["java", "-jar", "app.jar"]
----------------------------------------------------------------------

3.b Build:
docker build -t library-management:latest .

Run:
docker run -d -p 8080:8080 --name library-container \
library-management:latest

Your PC if Jenkins uses host 8080:
docker run -d -p 8083:8080 --name library-container \
library-management:latest

3.c Four troubleshooting commands/checks:
docker ps
docker ps -a
docker logs <container>
docker inspect <container>

3.d If container runs but browser gives 404:
- Check logs.
- Verify Java application started.
- Verify correct URL/path/context.
- Verify application listens on expected internal port.
- Use docker exec to inspect container if required.

======================================================================
PART AK – EXACT SET-3 PART I / POM POINTS TO REMEMBER
======================================================================

Java 17:
<maven.compiler.release>17</maven.compiler.release>

OR:
<maven.compiler.source>17</maven.compiler.source>
<maven.compiler.target>17</maven.compiler.target>

JAR:
<packaging>jar</packaging>

Exact output name:
<finalName>library-management</finalName>

Executable JAR:
maven-jar-plugin + correct Main-Class.

Build:
mvn clean package

Check:
java -version
mvn -version

======================================================================
PART AL – GITHUB SCENARIO COMMAND QUICK ANSWERS
======================================================================

Wrong unstaged changes:
git restore filename

Remove staged file without losing changes:
git restore --staged filename

Wrong unpushed commit message:
git commit --amend -m "Corrected commit message"

Readable history:
git log --oneline

Global name/email:
git config --global user.name "Your Name"
git config --global user.email "email@example.com"

See edits before staging:
git diff

Switch to feature/login:
git switch feature/login

Push local commits:
git push origin main

Fetch without merge:
git fetch origin

Create search-filter and switch:
git switch -c search-filter

Merge signup into main:
git checkout main
git merge feature/signup

Resolve conflict:
git status
# edit conflict
git add <file>
git commit
git push

Ignore .log and node_modules:
Add to .gitignore:
*.log
node_modules/

Who changed line:
git blame script.py

Save work temporarily:
git stash

Restore stash:
git stash apply

Delete merged branch:
git branch -d feature-ui

Force delete unmerged branch:
git branch -D feature-experiment

Check before deleting:
git branch --merged
(or inspect git log/branch status as needed)

Delete multiple merged branches:
git branch -d feature-a feature-b feature-c

======================================================================
PART AM – REMOTE REPOSITORY SCENARIO QUICK ANSWERS
======================================================================

Clone:
git clone <URL>

See remotes:
git remote -v

Add remote:
git remote add origin <URL>

Remove remote:
git remote remove origin

Rename remote:
git remote rename origin upstream

Fetch:
git fetch origin

Pull + merge:
git pull origin main

Push:
git push origin main

First push + upstream:
git push --set-upstream origin feature-branch

Change remote URL:
git remote set-url origin <URL>

List remote branches:
git branch -r

Prune stale deleted remote branches:
git remote prune origin

Fetch specific branch:
git fetch origin feature-branch

Remote details:
git remote show origin

Rebase onto remote:
git fetch origin
git rebase origin/main

======================================================================
PART AN – DOCKER IMAGE VS CONTAINER THEORY
======================================================================

IMAGE:
- Template/package.
- Used to create containers.
- Built with docker build.
- Stored locally or on Docker Hub.
- Example: library-management:latest

CONTAINER:
- Running/stopped instance created from an image.
- Created/started with docker run.
- Can be stopped, started, removed.
- Check with docker ps / docker ps -a.

MEMORY:
image = blueprint/package
container = instance of that image

======================================================================
PART AO – EXAM-DAY MASTER FLOW
======================================================================

IF GIVEN A GITHUB URL:
1. git clone <URL>
2. cd <project>

CHECK ENVIRONMENT:
3. java -version
4. mvn -version
5. docker --version

CHECK POM:
6. packaging = jar OR war
7. Java = 17
8. dependencies
9. finalName if exact output requested
10. Main-Class if executable JAR is required

BUILD:
11. mvn clean package
12. dir target / ls target

TEST JAR IF APPLICABLE:
13. java -jar target/library-management.jar

CREATE DOCKERFILE:
14. Match JAR/WAR type correctly.

BUILD IMAGE:
15. docker build -t library-management:latest .

CHECK:
16. docker image ls

RUN:
17. docker run -d -p HOST:CONTAINER --name library-container \
    library-management:latest

CHECK:
18. docker ps
19. docker ps -a
20. docker logs library-container

DOCKER HUB:
21. docker login
22. docker tag library-management:latest \
    YOUR_USERNAME/library-management:latest
23. docker push YOUR_USERNAME/library-management:latest

PULL TEST:
24. docker pull YOUR_USERNAME/library-management:latest
25. docker run -d -p HOST:CONTAINER --name library-container \
    YOUR_USERNAME/library-management:latest

GITHUB PUSH:
26. git status
27. git add .
28. git commit -m "Initial commit"
29. git branch -M main
30. git remote add origin <YOUR_GITHUB_URL>
31. git remote -v
32. git push -u origin main

======================================================================
PART AP – FINAL PRE-SUBMISSION CHECKLIST
======================================================================

[ ] Docker Desktop running
[ ] Git works
[ ] Java 17 installed
[ ] Maven uses Java 17
[ ] Correct GitHub URL
[ ] Correct branch (usually main)
[ ] POM XML syntax correct
[ ] packaging correct (jar/war)
[ ] Correct Java compiler version
[ ] Dependencies resolve
[ ] mvn clean package = BUILD SUCCESS
[ ] target contains expected JAR/WAR
[ ] finalName correct if exact filename required
[ ] Main-Class configured if java -jar is required
[ ] java -jar works for executable JAR
[ ] Dockerfile exists in project root
[ ] COPY path matches actual target file
[ ] .dockerignore is not hiding required target content
[ ] docker build command ends with "."
[ ] docker image ls shows image
[ ] Host port is free
[ ] Correct HOST:CONTAINER mapping
[ ] docker ps shows running container when app stays running
[ ] docker ps -a used if container exits
[ ] docker logs checked on failure
[ ] Docker Hub login works
[ ] Docker image tagged with username/repository:tag
[ ] docker push succeeds
[ ] Git status checked
[ ] Git add/commit done
[ ] Correct remote configured
[ ] git push succeeds
[ ] Refresh GitHub and verify files
[ ] Refresh Docker Hub and verify image

======================================================================
ULTRA-SHORT MEMORY BLOCK
======================================================================

MAVEN:
java -version
mvn -version
mvn clean package
dir target

JAR:
FROM eclipse-temurin:17-jdk
COPY target/library-management.jar app.jar
EXPOSE 8080
CMD ["java","-jar","app.jar"]

WAR:
FROM tomcat:9.0
COPY target/*.war /usr/local/tomcat/webapps/ROOT.war
EXPOSE 8080
CMD ["catalina.sh","run"]

DOCKER:
docker build -t image:latest .
docker image ls
docker run -d -p HOST:CONTAINER --name name image:latest
docker ps
docker ps -a
docker logs name
docker inspect name
docker stop name
docker start name
docker rm name

DOCKER HUB:
docker login
docker tag image:latest USER/repo:latest
docker push USER/repo:latest
docker pull USER/repo:latest

GITHUB:
git status
git add .
git commit -m "..."
git branch -M main
git remote add origin <URL>
git remote -v
git push -u origin main

CORE DIFFERENCES:
JAR → Main-Class may be required for java -jar
WAR → Tomcat deploys WAR
finalName → filename
mainClass → executable entry point
EXPOSE → documents container port
-p HOST:CONTAINER → actually publishes/maps port
GitHub → source code
Docker Hub → images

======================================================================
END OF MASTER CHECKLIST
======================================================================
Yes. If the exam gives you a WAR-based web application, follow this flow:

Maven → WAR → Tomcat Docker image → Container → localhost

Your uploaded material gives the traditional WAR/Tomcat pattern.

1. Check pom.xml

For a WAR project, the important part is:

<packaging>war</packaging>

Not:

<packaging>jar</packaging>

So Maven knows that it must create a .war file.

2. Build the WAR

Inside the project folder:

mvn clean package

Maven will create the WAR inside:

target/

Check it:

Windows:

dir target

Linux/Mac:

ls target

You should see something like:

library-management.war

The important thing is that mvn clean package creates the WAR.

3. Create the Dockerfile

For a traditional WAR application, create:

Dockerfile

Use:

FROM tomcat:9.0

COPY target/*.war /usr/local/tomcat/webapps/ROOT.war

EXPOSE 8080

CMD ["catalina.sh", "run"]

This is the WAR/Tomcat pattern given in your material.

Understand it
FROM tomcat:9.0

Means:

Start with a Docker image that already contains Tomcat.

COPY target/*.war /usr/local/tomcat/webapps/ROOT.war

This is the most important WAR line.

Your Maven creates:

target/library-management.war

Docker copies it into Tomcat's:

/usr/local/tomcat/webapps/

as:

ROOT.war

ROOT.war means the application becomes the root web application /.

EXPOSE 8080

Tomcat normally listens on 8080 inside the container.

Remember: EXPOSE doesn't actually publish the port to your PC.

CMD ["catalina.sh", "run"]

Starts Tomcat in the foreground.

For WAR:

Tomcat runs the application, not java -jar.

4. Build Docker image

Make sure you are in the project directory containing:

pom.xml
Dockerfile
target/

Then:

docker build -t library-war:latest .

Don't forget the .

The dot tells Docker to use the current directory as the build context.

5. Check image
docker image ls

You should see:

library-war    latest
6. Run the WAR container

If your PC's port 8080 is free:

docker run -d -p 8080:8080 --name library-war-container library-war:latest

Then open:

http://localhost:8080

The mapping is:

Your PC                 Container
8080  ───────────────→  8080
       -p 8080:8080
If port 8080 is already occupied

For example, Jenkins is using 8080:

docker run -d -p 8083:8080 --name library-war-container library-war:latest

Then open:

http://localhost:8083

Notice:

8083:8080
  ↑    ↑
host   container

Tomcat still uses 8080 inside the container.

7. Check the container
docker ps

Then:

docker logs library-war-container

If there is a problem, the material recommends:

docker ps
docker ps -a
docker logs library-war-container
docker inspect library-war-container

⭐ Full WAR exam answer

If they ask:

Dockerize the Maven WAR application using Tomcat and make it accessible on port 8080.

Write this sequence:

Maven
mvn clean package
dir target
Dockerfile
FROM tomcat:9.0

COPY target/*.war /usr/local/tomcat/webapps/ROOT.war

EXPOSE 8080

CMD ["catalina.sh", "run"]
Build
docker build -t library-war:latest .
Run
docker run -d -p 8080:8080 --name library-war-container library-war:latest
Test
http://localhost:8080
Check
docker ps
docker logs library-war-container
🧠 JAR vs WAR — memorize this
JAR
 ↓
mvn clean package
 ↓
target/app.jar
 ↓
FROM eclipse-temurin:17-jdk
 ↓
java -jar app.jar

versus

WAR
 ↓
mvn clean package
 ↓
target/app.war
 ↓
FROM tomcat:9.0
 ↓
COPY WAR → Tomcat/webapps
 ↓
catalina.sh run

The biggest exam difference is:

JAR → Java runs the JAR
WAR → Tomcat deploys and runs the
