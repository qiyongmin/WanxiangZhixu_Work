"""Local-only Project Skills discovery must never copy private files to Common registry."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import project_skills
import work_resource_api

class ProjectSkillsCatalogTests(unittest.TestCase):
    def test_common_private_layers_are_metadata_only(self):
        fake={"schemaVersion":1,"skills":[
            {"id":"work.work-hub","name":"Work Hub","description":"Generic command hub",
              "status":"active","path":".agents/skills/work/work-hub/SKILL.md",
              "scope":["tools/*"],"instructions":"Internal instructions"},
            {"id":"work.private-example","name":"Private Project",
              "description":"Project-specific context","status":"active",
              "path":"private/example/SKILL.md","scope":["confidential/*"],
              "instructions":"Private material","references":[{"content":"Private attachment"}]}
        ]}
        with patch.object(project_skills,"registry",return_value=fake):
            output=work_resource_api.handle("GET",{"view":["project-skills"]})
        self.assertTrue(output["localOnly"])
        self.assertTrue(output["metadataOnly"])
        self.assertFalse(output["sharedToCentral"])
        self.assertEqual([item["layer"] for item in output["skills"]],["local","local"])
        for item in output["skills"]:
            self.assertEqual(set(item),{"id","name","description","status","layer","source"})
        self.assertNotIn("Private attachment",str(output))
        self.assertNotIn("Private material",str(output))
        self.assertNotIn("confidential",str(output))

    def test_project_skills_do_not_enter_the_resource_registry(self):
        fake={"skills":[{"id":"work.private-example","name":"Private Project",
            "description":"Local business workflow","status":"active"}]}
        with patch.object(project_skills,"registry",return_value=fake):
            output=work_resource_api.project_skills_catalog()
        self.assertEqual(output["skills"][0]["layer"],"local")
        self.assertNotIn("files",output["skills"][0])
        self.assertNotIn("sourcePath",output["skills"][0])

if __name__=="__main__":
    unittest.main()
